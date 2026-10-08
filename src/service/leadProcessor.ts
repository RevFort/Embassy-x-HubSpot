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

/** How long a fetched dropdown's valid options are trusted before re-fetching from HubSpot. */
const OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;

export class LeadProcessor {
  private readonly lock = new KeyedLock();
  private readonly propertyOptionsCache = new Map<string, { values: string[]; expiresAt: number }>();

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
      [id.email, enquiry.email ?? placeholderEmail(enquiry)],
    ];
    for (const [prop, value] of assign) {
      if (value) props[prop] = value;
    }
    if (this.cfg.ownerId) props.hubspot_owner_id = this.cfg.ownerId;
    props[this.cfg.enquiryCountProperty] = '1';

    const contactId = await this.crm.create('contacts', props);
    return { id: contactId, properties: props as Record<string, string> };
  }

  /** Fills in new identifiers (primary slot if empty, else alternate slot) and applies the field mapping. */
  private async updateContact(enquiry: Enquiry, contact: CrmRecord, warnings: string[]) {
    const props = await this.mappedProperties(enquiry, contact.properties, warnings);
    const id = this.cfg.identity;
    const cc = enquiry.countryCode;

    const countProp = this.cfg.enquiryCountProperty;
    const existingCount = Number(contact.properties[countProp]);
    const baseCount = Number.isFinite(existingCount) && existingCount > 0 ? existingCount : 1;
    props[countProp] = String(baseCount + 1);

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

    const knownEmail = contact.properties[id.email]?.toLowerCase();
    if (enquiry.email && enquiry.email !== knownEmail) {
      if (!contact.properties[id.email] && !props[id.email]) props[id.email] = enquiry.email;
      else warnings.push(`No empty email field on contact ${contact.id} for ${enquiry.email}`);
    } else if (!enquiry.email && !contact.properties[id.email] && !props[id.email]) {
      // No email supplied and none on file: set the placeholder. An existing email is never overwritten.
      const placeholder = placeholderEmail(enquiry);
      if (placeholder) props[id.email] = placeholder;
    }

    try {
      await this.crm.update('contacts', contact.id, props);
    } catch (err) {
      // Email is unique: if the new email belongs to a different contact, keep going without it.
      if (err instanceof HubSpotError && err.status === 409) {
        warnings.push(`Contact ${contact.id} not fully updated: ${err.message}`);
        delete props[id.email];
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
      f.utm_source && `UTM source (ads): ${f.utm_source}`,
      f.utm_campaign && `UTM campaign: ${f.utm_campaign}`,
      f.utm_medium && `UTM medium: ${f.utm_medium}`,
      f.utm_term && `UTM term: ${f.utm_term}`,
      f.gclid && `GCLID: ${f.gclid}`,
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
        if (target.validateOptionsOf) await this.assertValidOption(target, coerced);
        if (existing) {
          if (target.onUpdate === 'skip') continue;
          if (target.onUpdate === 'fillEmpty' && existing[target.property]) continue;
          if (target.onUpdate === 'append') {
            const combined = appendValue(existing[target.property], coerced);
            if (combined === existing[target.property]) continue;
            props[target.property] = combined;
            continue;
          }
          if (existing[target.property] === coerced) continue;
        }
        props[target.property] = coerced;
      }
    }
    return props;
  }

  /**
   * Rejects a value that isn't one of `target.validateOptionsOf`'s current HubSpot dropdown options,
   * with the same "invalid option" wording HubSpot itself returns for a real enumeration property.
   */
  private async assertValidOption(target: MappingTarget, value: string): Promise<void> {
    const options = await this.validOptionsFor(target.validateOptionsOf!);
    if (options.length === 0 || options.includes(value)) return;
    throw new ValidationError(
      `Property "${target.property}" value "${value}" is not a valid value for this property. Valid values are: ${options.join(', ')}`,
    );
  }

  private async validOptionsFor(property: string): Promise<string[]> {
    const cached = this.propertyOptionsCache.get(property);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.values;
    const values = await this.crm.getPropertyOptions('contacts', property);
    this.propertyOptionsCache.set(property, { values, expiresAt: now + OPTIONS_CACHE_TTL_MS });
    return values;
  }

  private async contactReadProperties(): Promise<string[]> {
    const id = this.cfg.identity;
    return [
      ...new Set([
        ...Object.values(id),
        'hubspot_owner_id',
        'lastmodifieddate',
        'createdate',
        this.cfg.enquiryCountProperty,
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

const PLACEHOLDER_EMAIL_DOMAIN = 'hubintegration.com';

/** `<phone digits>@hubintegration.com`, used when a lead arrives without an email. */
function placeholderEmail(e: Enquiry): string | undefined {
  const phone = e.mobile ?? e.alternateMobile;
  return phone ? `${phone.e164.replace(/\D/g, '')}@${PLACEHOLDER_EMAIL_DOMAIN}` : undefined;
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

/** Adds `value` to a comma-separated list, skipping it if already present. */
function appendValue(existing: string | null | undefined, value: string): string {
  const parts = existing ? existing.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!parts.includes(value)) parts.push(value);
  return parts.join(', ');
}

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
