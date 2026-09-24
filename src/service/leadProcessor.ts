import type { Logger } from 'pino';
import type { AppConfig, FieldMapping, MappingTarget } from '../config.js';
import { HubSpotError, type Crm, type CrmProperties, type CrmRecord, type FilterGroup } from '../hubspot/client.js';
import { normalizePhone, parseEnquiry, ValidationError, type Enquiry, type NormalizedPhone } from '../normalize.js';
import { KeyedLock } from './keyedLock.js';

export type LeadAction = 'EXISTING_CONTACT_UPDATED' | 'NEW_CONTACT_CREATED';

/** Result for one incoming lead. The agency's "lead" is a HubSpot Contact; no Lead objects are used. */
export interface LeadResult {
  /** Existing or new Contact ID, or the error message. */
  responseId: string;
  status: 200 | 400;
  errorcode?: string;
  action?: LeadAction;
  contactId?: string;
  warnings: string[];
}

export class LeadProcessor {
  private readonly lock = new KeyedLock();

  constructor(
    private readonly crm: Crm,
    private readonly cfg: AppConfig,
    private readonly mapping: FieldMapping,
    private readonly log: Logger,
  ) {}

  async processLead(input: unknown): Promise<LeadResult> {
    let enquiry: Enquiry;
    try {
      enquiry = parseEnquiry(input, this.cfg.defaultCountryCode);
    } catch (err) {
      return errorResult(err);
    }
    return this.processEnquiry(enquiry);
  }

  private async processEnquiry(enquiry: Enquiry): Promise<LeadResult> {
    try {
      return await this.lock.withLocks(enquiry.identityKeys, () => this.decide(enquiry, [...enquiry.warnings]));
    } catch (err) {
      this.log.error({ err, identityKeys: enquiry.identityKeys }, 'Lead processing failed');
      return { ...errorResult(err), warnings: enquiry.warnings };
    }
  }

  private async decide(enquiry: Enquiry, warnings: string[], extraContactIds: string[] = []): Promise<LeadResult> {
    const contact = pickPrimaryContact(enquiry, await this.findContacts(enquiry, extraContactIds));

    // Re-enquiry: the contact already exists, so update it instead of creating a duplicate.
    if (contact) return this.handleExistingContact(enquiry, contact, warnings);

    // Genuine new enquiry.
    let created: CrmRecord;
    try {
      created = await this.createContact(enquiry, warnings);
    } catch (err) {
      // Email is unique in HubSpot: a 409 means the contact exists but was not searchable yet. Re-run with it.
      const existingId = err instanceof HubSpotError ? err.existingId : undefined;
      if (existingId && !extraContactIds.includes(existingId)) {
        warnings.push(`Contact ${existingId} found via email conflict on create`);
        return this.decide(enquiry, warnings, [...extraContactIds, existingId]);
      }
      throw err;
    }
    await this.recordCampaignAttribution(enquiry, created.id, warnings);
    return { responseId: created.id, status: 200, action: 'NEW_CONTACT_CREATED', contactId: created.id, warnings };
  }

  /** Existing contact stays primary, is updated, attribution is recorded, and its ID is returned. */
  private async handleExistingContact(enquiry: Enquiry, contact: CrmRecord, warnings: string[]): Promise<LeadResult> {
    await this.updateContact(enquiry, contact, warnings);
    await this.recordCampaignAttribution(enquiry, contact.id, warnings);
    await this.createReEnquiryTask(enquiry, contact, warnings);
    return { responseId: contact.id, status: 200, action: 'EXISTING_CONTACT_UPDATED', contactId: contact.id, warnings };
  }

  // ---------------------------------------------------------------- lookups

  private async findContacts(enquiry: Enquiry, extraIds: string[]): Promise<CrmRecord[]> {
    const id = this.cfg.identity;
    const phoneProps = [id.mobile, id.alternateMobile];

    const phoneValues = [...new Set(phonesOf(enquiry).flatMap((p) => p.variants))];

    const groups: FilterGroup[] = [];
    if (phoneValues.length) {
      for (const p of phoneProps) groups.push({ filters: [{ propertyName: p, operator: 'IN', values: phoneValues }] });
    }

    const properties = await this.contactReadProperties();
    const found = groups.length ? await this.crm.search('contacts', groups, properties) : [];

    const knownIds = new Set(found.map((c) => c.id));
    const missing = extraIds.filter((i) => !knownIds.has(i));
    if (missing.length) found.push(...(await this.crm.batchRead('contacts', missing, properties)));
    return found;
  }

  // ---------------------------------------------------------------- writes

  private async createContact(enquiry: Enquiry, warnings: string[]): Promise<CrmRecord> {
    const props = await this.mappedProperties(enquiry, undefined, warnings);
    const id = this.cfg.identity;
    const assign: [string, string | undefined][] = [
      [id.mobile, enquiry.mobile?.e164],
      [id.alternateMobile, enquiry.alternateMobile?.e164],
      [id.email, enquiry.email],
      [id.alternateEmail, enquiry.alternateEmail],
    ];
    for (const [prop, value] of assign) {
      if (value) props[prop] = value;
    }
    const { reEnquiryCountProperty, lastEnquiryAtProperty, rawPayloadProperty } = this.cfg.tracking;
    if (reEnquiryCountProperty) props[reEnquiryCountProperty] = '0';
    if (lastEnquiryAtProperty) props[lastEnquiryAtProperty] = new Date().toISOString();
    if (rawPayloadProperty) props[rawPayloadProperty] = rawPayload(enquiry);

    const contactId = await this.crm.create('contacts', props);
    return { id: contactId, properties: props as Record<string, string> };
  }

  /** Fills in new identifiers (primary slot if empty, else alternate slot), applies the field mapping, and counts the re-enquiry. */
  private async updateContact(enquiry: Enquiry, contact: CrmRecord, warnings: string[]) {
    const props = await this.mappedProperties(enquiry, contact.properties, warnings);
    const id = this.cfg.identity;
    const cc = enquiry.fields.countrycode ?? this.cfg.defaultCountryCode;

    const phoneSlots = [id.mobile, id.alternateMobile];
    const knownPhones = new Set(
      phoneSlots.map((p) => contact.properties[p]).flatMap((v) => (v ? [normalizePhone(v, cc)?.key] : [])),
    );
    const placePhone = (phone: NormalizedPhone | undefined, slots: string[]) => {
      if (!phone || knownPhones.has(phone.key)) return;
      const slot = slots.find((s) => !contact.properties[s] && !props[s]);
      if (slot) props[slot] = phone.e164;
      else warnings.push(`No empty phone field on contact ${contact.id} for ${phone.e164}`);
      knownPhones.add(phone.key);
    };
    placePhone(enquiry.mobile, [id.mobile, id.alternateMobile]);
    placePhone(enquiry.alternateMobile, [id.alternateMobile, id.mobile]);

    const knownEmails = new Set([id.email, id.alternateEmail].map((p) => contact.properties[p]?.toLowerCase()).filter(Boolean));
    for (const email of [enquiry.email, enquiry.alternateEmail]) {
      if (!email || knownEmails.has(email)) continue;
      const slot = [id.email, id.alternateEmail].find((s) => !contact.properties[s] && !props[s]);
      if (slot) props[slot] = email;
      else warnings.push(`No empty email field on contact ${contact.id} for ${email}`);
      knownEmails.add(email);
    }

    const { reEnquiryCountProperty, lastEnquiryAtProperty, rawPayloadProperty } = this.cfg.tracking;
    if (reEnquiryCountProperty) {
      props[reEnquiryCountProperty] = String((Number(contact.properties[reEnquiryCountProperty]) || 0) + 1);
    }
    if (lastEnquiryAtProperty) props[lastEnquiryAtProperty] = new Date().toISOString();
    if (rawPayloadProperty) props[rawPayloadProperty] = rawPayload(enquiry);

    try {
      await this.crm.update('contacts', contact.id, props);
    } catch (err) {
      // Email is unique: if the new email belongs to a different contact, keep going without it.
      if (err instanceof HubSpotError && err.status === 409) {
        warnings.push(`Contact ${contact.id} not fully updated: ${err.message}`);
        for (const p of [id.email, id.alternateEmail]) delete props[p];
        await this.crm.update('contacts', contact.id, props);
      } else throw err;
    }
  }

  /** SOP step 5: record the campaign on a Campaign Member linked to the campaign and contact. Never fails the request. */
  private async recordCampaignAttribution(enquiry: Enquiry, contactId: string, warnings: string[]) {
    const c = this.cfg.campaign;
    const campaignId = enquiry.fields.campaignid;
    if (!c.enabled || !campaignId) return;
    if (!c.objectType || !c.memberObjectType) {
      warnings.push('CAMPAIGN_ENABLED is set but CAMPAIGN_OBJECT_TYPE / CAMPAIGN_MEMBER_OBJECT_TYPE are not configured');
      return;
    }
    try {
      const [campaign] = await this.crm.search(
        c.objectType,
        [{ filters: [{ propertyName: c.idProperty, operator: 'EQ', value: campaignId }] }],
        [c.idProperty],
      );
      if (!campaign) {
        warnings.push(`Campaign ${campaignId} not found in ${c.objectType}; no campaign member created`);
        return;
      }
      const name = [enquiry.fields.firstname, enquiry.fields.lastname].filter(Boolean).join(' ');
      const memberId = await this.crm.create(c.memberObjectType, {
        [c.memberNameProperty]: `${name} - ${campaignId}`,
        [c.memberStatusProperty]: c.memberStatusValue,
      });
      await this.crm.associateDefault(c.memberObjectType, memberId, c.objectType, campaign.id);
      await this.crm.associateDefault(c.memberObjectType, memberId, 'contacts', contactId);
    } catch (err) {
      warnings.push(`Campaign attribution failed: ${(err as Error).message}`);
      this.log.warn({ err, campaignId, contactId }, 'Campaign attribution failed');
    }
  }

  /** SOP step 5: a follow-up Task so the owner sees the re-enquiry. Never fails the request. */
  private async createReEnquiryTask(enquiry: Enquiry, contact: CrmRecord, warnings: string[]) {
    if (!this.cfg.createTaskOnReEnquiry) return;
    const subject = 'Re-enquiry from existing contact';
    const project = this.projectOf(enquiry);
    const f = enquiry.fields;
    const lines = [
      'A new enquiry was received from the marketing agency for an existing contact.',
      project && `Project: ${project}`,
      f.enquirydate && `Enquiry date: ${f.enquirydate}`,
      f.leadsource && `Lead source: ${f.leadsource}`,
      f.subsource && `Sub-source: ${f.subsource}`,
      f.utm_ssc && `UTM source: ${f.utm_ssc}`,
      f.medium && `Medium: ${f.medium}`,
      f.term && `Term: ${f.term}`,
      f.campaignid && `Campaign ID: ${f.campaignid}`,
      f.comments && `Comments: ${f.comments}`,
    ].filter(Boolean);
    try {
      const taskId = await this.crm.create('tasks', {
        hs_task_subject: project ? `${subject}: ${project}` : subject,
        hs_task_body: lines.join('\n'),
        hs_timestamp: new Date().toISOString(),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'HIGH',
        hs_task_type: 'CALL',
        hubspot_owner_id: contact.properties.hubspot_owner_id ?? undefined,
      });
      await this.crm.associateDefault('tasks', taskId, 'contacts', contact.id);
    } catch (err) {
      warnings.push(`Re-enquiry task creation failed: ${(err as Error).message}`);
      this.log.warn({ err, contactId: contact.id }, 'Task creation failed');
    }
  }

  // ---------------------------------------------------------------- mapping helpers

  /** Applies config/field-mapping.json. With `existing`, honours each target's onUpdate rule. */
  private async mappedProperties(
    enquiry: Enquiry,
    existing: Record<string, string | null> | undefined,
    warnings: string[],
  ): Promise<CrmProperties> {
    const props: CrmProperties = {};
    for (const field of this.mapping.fields) {
      const value = enquiry.fields[field.source];
      if (value === undefined) continue;
      for (const target of field.targets) {
        const coerced = coerce(value, target, warnings);
        if (coerced === undefined) continue;
        if (existing) {
          if (target.onUpdate === 'skip') continue;
          if (target.onUpdate === 'fillEmpty' && existing[target.property]) continue;
          if (existing[target.property] === coerced) continue;
        }
        props[target.property] = coerced;
      }
    }
    return props;
  }

  private async contactReadProperties(): Promise<string[]> {
    const id = this.cfg.identity;
    return [
      ...new Set([
        ...Object.values(id),
        'hubspot_owner_id',
        'lastmodifieddate',
        'createdate',
        this.cfg.tracking.reEnquiryCountProperty,
        ...this.mapping.fields.flatMap((f) => f.targets.map((t) => t.property)),
      ]),
    ].filter(Boolean);
  }

  private projectOf(enquiry: Enquiry): string | undefined {
    return enquiry.fields.project_interested ?? enquiry.fields.project;
  }
}

// ------------------------------------------------------------------ pure helpers

export function errorResult(err: unknown): LeadResult {
  const message = err instanceof Error ? err.message : String(err);
  let errorcode = 'INTERNAL_ERROR';
  if (err instanceof ValidationError) errorcode = err.errorcode;
  else if (err instanceof HubSpotError) {
    errorcode = err.status === 409 && /mobile|phone/i.test(message) ? 'MOBILE_ALREADY_EXISTS' : 'HUBSPOT_ERROR';
  }
  return { responseId: message, status: 400, errorcode, warnings: [] };
}

function phonesOf(e: Enquiry): NormalizedPhone[] {
  return [e.mobile, e.alternateMobile].filter((p): p is NormalizedPhone => !!p);
}

/** Prefer the contact matched on the incoming mobile, then the most recently modified. */
function pickPrimaryContact(enquiry: Enquiry, contacts: CrmRecord[]): CrmRecord | undefined {
  const sorted = newestFirst(contacts);
  const mobile = enquiry.mobile;
  if (mobile) {
    const byMobile = sorted.find((c) =>
      Object.values(c.properties).some((v) => !!v && mobile.variants.includes(v)),
    );
    if (byMobile) return byMobile;
  }
  return sorted[0];
}

const ts = (r: CrmRecord) => Date.parse(r.properties.lastmodifieddate ?? r.properties.createdate ?? '') || 0;

const newestFirst = (records: CrmRecord[]) => [...records].sort((a, b) => ts(b) - ts(a));

const rawPayload = (e: Enquiry) => JSON.stringify(e.raw).slice(0, 65000);

function coerce(value: string, target: MappingTarget, warnings: string[]): string | undefined {
  if (target.type === 'date') {
    const d = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
    if (d && !Number.isNaN(Date.parse(d))) return d;
    warnings.push(`Ignored invalid date for ${target.property}: "${value}"`);
    return undefined;
  }
  if (target.type === 'number') {
    if (value !== '' && Number.isFinite(Number(value))) return value;
    warnings.push(`Ignored invalid number for ${target.property}: "${value}"`);
    return undefined;
  }
  return value;
}
