import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Aurum, AurumPayload, AurumResult } from '../aurum/client.js';
import type { AppConfig, ConversionEvents } from '../config.js';
import type { Crm, CrmRecord } from '../hubspot/client.js';
import { normalizePhone } from '../normalize.js';

export interface HubSpotWebhookEvent {
  eventId?: number;
  subscriptionType?: string;
  objectId?: number;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
}

export type ForwardOutcome = 'sent' | 'skipped' | 'failed';

export interface ForwardResult {
  outcome: ForwardOutcome;
  reason?: string;
  contactId?: string;
  eventName?: string;
  aurumEventId?: string;
  aurumId?: string;
  routedTo?: string | null;
  durationMs: number;
}

const PROJECTS = ['Embassy Edge', 'Embassy One Thane', 'Embassy Terazza'];
const SOURCES: Record<string, string> = { facebook: 'Facebook', google: 'Google' };

const squash = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class ConversionForwarder {
  constructor(
    private readonly crm: Crm,
    private readonly aurum: Aurum,
    private readonly cfg: AppConfig,
    private readonly rules: ConversionEvents,
    private readonly log: Logger,
  ) {}

  async forward(event: HubSpotWebhookEvent): Promise<ForwardResult> {
    const started = Date.now();
    const done = (r: Omit<ForwardResult, 'durationMs'>): ForwardResult => ({ ...r, durationMs: Date.now() - started });
    const skip = (reason: string, extra: Partial<ForwardResult> = {}) => done({ outcome: 'skipped', reason, ...extra });

    try {
      if (event.subscriptionType !== 'contact.propertyChange') return skip(`ignored subscriptionType ${event.subscriptionType}`);
      const rule = this.rules.events.find((r) => r.property === event.propertyName);
      if (!rule) return skip(`no conversion event configured for property ${event.propertyName}`);
      const eventName = rule.eventName;
      if (rule.when && !rule.when.some((v) => squash(v) === squash(event.propertyValue ?? ''))) {
        return skip(`value "${event.propertyValue}" is not a trigger for ${rule.property}`, { eventName });
      }
      if (event.objectId === undefined || event.eventId === undefined || event.occurredAt === undefined) {
        return skip('event is missing objectId / eventId / occurredAt', { eventName });
      }

      const contactId = String(event.objectId);
      const contact = await this.findContact(contactId, rule.valueProperty);
      if (!contact) return skip('contact not found', { contactId, eventName });

      const built = this.buildPayloads(event as Required<HubSpotWebhookEvent>, contact, eventName, rule.valueProperty);
      if ('skip' in built) return skip(built.skip, { contactId, eventName });
      
      const results: Omit<ForwardResult, 'durationMs'>[] = [];
      for (const payload of built.payloads) {
        const res = await this.aurum.send(payload);
        results.push(toForwardResult(res, { contactId, eventName, aurumEventId: payload.event_id }));
      }
      return done(combine(results));
    } catch (err) {
      this.log.error({ err, event }, 'Conversion forwarding failed');
      return done({ outcome: 'failed', reason: (err as Error).message, contactId: String(event.objectId) });
    }
  }

  private async findContact(contactId: string, valueProperty?: string): Promise<CrmRecord | undefined> {
    const { identity, conversions } = this.cfg;
    const properties = [
      ...new Set(
        [identity.mobile, identity.alternateMobile, identity.email, valueProperty, ...Object.values(conversions.props)].filter(
          (p): p is string => !!p,
        ),
      ),
    ];
    const [contact] = await this.crm.search('contacts', [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: contactId }] }], properties);
    return contact;
  }

  private buildPayloads(
    event: Required<HubSpotWebhookEvent>,
    contact: CrmRecord,
    eventName: string,
    valueProperty?: string,
  ): { payloads: AurumPayload[] } | { skip: string } {
    const { identity, conversions, defaultCountryCode } = this.cfg;
    const p = contact.properties;
    const list = (v: string | null | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const sources = unique(list(p[conversions.props.source]).flatMap((s) => SOURCES[squash(s)] ?? []));
    if (!sources.length) return { skip: `source "${p[conversions.props.source] ?? ''}" is not Facebook or Google; Aurum would not forward it` };

    const projects = unique(
      [...list(p[conversions.props.project]), ...list(p[conversions.props.alsoProject])].flatMap(
        (v) => PROJECTS.find((n) => squash(n) === squash(v)) ?? [],
      ),
    );
    if (!projects.length) {
      return { skip: `no valid project in "${p[conversions.props.project] ?? ''}" / "${p[conversions.props.alsoProject] ?? ''}"; expected ${PROJECTS.join(', ')}` };
    }

    const phone = [p[identity.mobile], p[identity.alternateMobile]]
      .flatMap((v) => (v ? [normalizePhone(v, defaultCountryCode)] : []))
      .find((n) => n !== undefined);
    if (!phone) return { skip: 'contact has no valid phone number' };

    const base: Pick<AurumPayload, 'phone_sha256' | 'phone_sha256_e164' | 'event_name' | 'event_time'> &
      Partial<AurumPayload> = {
      phone_sha256: sha256(phone.e164.slice(1)),
      phone_sha256_e164: sha256(phone.e164),
      event_name: eventName,
      event_time: new Date(event.occurredAt).toISOString(),
    };

    const email = p[identity.email]?.trim().toLowerCase();
    if (email) base.email_sha256 = sha256(email);

    // gclid / meta_leadgen_id are "append" properties (comma-separated history): the latest is last.
    const gclid = list(p[conversions.props.gclid]).pop();
    if (gclid && gclid.length <= 512) base.gclid = gclid;
    const leadId = list(p[conversions.props.metaLeadId]).pop();
    if (leadId && /^\d{1,20}$/.test(leadId)) base.lead_id = leadId;

    const remark = p[conversions.props.remark]?.trim();
    if (remark) base.lead_remark = remark.slice(0, 2000);

    const value = valueProperty ? Number(p[valueProperty]) : NaN;
    if (valueProperty && p[valueProperty] && Number.isFinite(value) && value >= 0) {
      base.value = value;
      base.currency = conversions.currency;
    }

    const payloads: AurumPayload[] = [];
    for (const project of projects) {
      for (const source of sources) {
        const suffix = `${slug(project)}${sources.length > 1 ? `-${slug(source)}` : ''}`;
        payloads.push({ ...base, project_name: project, source, event_id: `hubspot-${event.eventId}-${suffix}` } as AurumPayload);
      }
    }
    return { payloads };
  }
}

const unique = <T>(xs: T[]) => [...new Set(xs)];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Several calls -> one result: failed if any failed, else skipped if all were, else sent. */
function combine(rs: Omit<ForwardResult, 'durationMs'>[]): Omit<ForwardResult, 'durationMs'> {
  if (rs.length === 1) return rs[0]!;
  const outcome: ForwardOutcome = rs.some((r) => r.outcome === 'failed') ? 'failed' : rs.every((r) => r.outcome === 'skipped') ? 'skipped' : 'sent';
  const reasons = rs.flatMap((r) => (r.reason ? [`${r.aurumEventId}: ${r.reason}`] : []));
  return {
    outcome,
    contactId: rs[0]!.contactId,
    eventName: rs[0]!.eventName,
    aurumEventId: rs.map((r) => r.aurumEventId).join(', '),
    aurumId: rs.map((r) => r.aurumId).filter(Boolean).join(', '),
    routedTo: rs[0]!.routedTo,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

function toForwardResult(
  res: AurumResult,
  base: Pick<ForwardResult, 'contactId' | 'eventName' | 'aurumEventId'>,
): Omit<ForwardResult, 'durationMs'> {
  const common = { ...base, aurumId: res.id, routedTo: res.routedTo };
  if (!res.success) return { ...common, outcome: 'failed', reason: res.error };
  // 201 with delivery "failed" is already accepted; Aurum retries it itself, so it is not our failure.
  if (res.delivery?.status === 'skipped') return { ...common, outcome: 'skipped', reason: `Aurum skipped: ${res.delivery.error}` };
  return { ...common, outcome: 'sent', ...(res.delivery?.status === 'failed' ? { reason: `Aurum delivery failed, retrying on their side: ${res.delivery.error}` } : {}) };
}
