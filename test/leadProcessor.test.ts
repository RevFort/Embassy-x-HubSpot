import { describe, expect, it } from 'vitest';
import { HubSpotError } from '../src/hubspot/client.js';
import { normalizePhone, parseEnquiry } from '../src/normalize.js';
import { samplePayload, setup } from './helpers.js';

const run = async (processor: ReturnType<typeof setup>['processor'], payload: unknown) => processor.processLead(payload);

describe('normalizePhone', () => {
  it('produces the same key for common formats', () => {
    const keys = ['6600110066', '+916600110066', '+91 66001 10066', '06600110066', '91-6600110066'].map(
      (v) => normalizePhone(v, '+91')?.key,
    );
    expect(new Set(keys)).toEqual(new Set(['916600110066']));
  });

  it('keeps foreign numbers given in full international form', () => {
    expect(normalizePhone('+971501234567', '+91')?.e164).toBe('+971501234567');
  });

  it('rejects junk', () => {
    expect(normalizePhone('abc', '91')).toBeUndefined();
    expect(normalizePhone('123', '91')).toBeUndefined();
  });
});

describe('parseEnquiry', () => {
  it('requires an identifier', () => {
    expect(() => parseEnquiry({ lastname: 'x' }, '91')).toThrow(/mobile or email/);
  });
  it('requires a name', () => {
    expect(() => parseEnquiry({ mobile: '6600110066' }, '91')).toThrow(/firstname or lastname/);
  });
});

describe('new enquiry', () => {
  it('creates a contact with all mapped fields and returns its ID', async () => {
    const { crm, processor } = setup();
    const r = await run(processor, samplePayload());

    const [contact] = crm.all('contacts');
    expect(r).toMatchObject({ status: 200, action: 'NEW_CONTACT_CREATED', responseId: contact!.id, contactId: contact!.id });
    expect(contact!.properties).toMatchObject({
      firstname: 'Test',
      lastname: 'aurum',
      email: 'testaurum@aa.in',
      phone: '+916600110066',
      project_interested: 'Embassy South Reserve',
      latest_project_interested: 'Embassy South Reserve',
      leadsource: 'Digital Marketing',
      mode_of_enquiry: 'Web',
      enquiry_utm_source: 'Facebook',
      enquiry_utm_medium: 'Webzaa',
      sf_campaign_id: '701fv00000MD4xKAAT',
      enquiry_date: '2026-05-12',
      requested_owner_queue: 'LMT Queue',
      re_enquiry_count: '0',
    });
    expect(contact!.properties.hubspot_owner_id).toBeUndefined(); // owner is never set by the API
    expect(contact!.properties.enquiry_utm_term).toBeUndefined(); // blank values are not written
    expect(JSON.parse(contact!.properties.marketing_api_raw_payload!)).toMatchObject({ utm_ssc: 'Facebook' });
    expect(crm.all('leads')).toHaveLength(0);
    expect(crm.all('tasks')).toHaveLength(0);
  });

});

describe('existing contact (re-enquiry)', () => {
  it('matches on mobile stored in a different format, updates the contact and returns its ID', async () => {
    const { crm, processor } = setup();
    const contactId = crm.seed('contacts', {
      firstname: 'Old',
      phone: '6600110066',
      enquiry_utm_source: 'Google',
      latest_project_interested: 'Embassy Lake Terraces',
      hubspot_owner_id: '42',
      re_enquiry_count: '2',
    });

    const r = await run(processor, samplePayload({ mobile: '+91 66001 10066', email: undefined }));

    expect(r).toMatchObject({ status: 200, action: 'EXISTING_CONTACT_UPDATED', responseId: contactId, contactId });
    expect(crm.all('contacts')).toHaveLength(1);
    const contact = crm.get('contacts', contactId)!;
    expect(contact.firstname).toBe('Old'); // fillEmpty: existing value kept
    expect(contact.enquiry_utm_source).toBe('Google'); // original attribution preserved
    expect(contact.leadsource).toBe('Digital Marketing'); // blank filled
    expect(contact.latest_project_interested).toBe('Embassy South Reserve'); // overwrite
    expect(contact.re_enquiry_count).toBe('3');
    expect(contact.hubspot_owner_id).toBe('42'); // not reassigned
    expect(JSON.parse(contact.marketing_api_raw_payload!)).toMatchObject({ mobile: '+91 66001 10066' });

    const [task] = crm.all('tasks');
    expect(task!.properties.hs_task_subject).toBe('Re-enquiry from existing contact: Embassy South Reserve');
    expect(task!.properties.hubspot_owner_id).toBe('42');
    expect(task!.properties.hs_task_body).toContain('UTM source: Facebook');
    expect(await crm.associatedIds('tasks', task!.id, 'contacts')).toEqual([contactId]);
  });

  it('matches on alternate email, and stores the new mobile on the contact', async () => {
    const { crm, processor } = setup();
    const contactId = crm.seed('contacts', { email: 'other@x.com', alternate_email: 'testaurum@aa.in', phone: '+919999999999' });

    const r = await run(processor, samplePayload());
    expect(r.responseId).toBe(contactId);
    expect(crm.get('contacts', contactId)).toMatchObject({ phone: '+919999999999', alternate_mobile: '+916600110066' });
  });

  it('prefers the contact matched on mobile over one matched on email', async () => {
    const { crm, processor } = setup();
    const byEmail = crm.seed('contacts', { email: 'testaurum@aa.in', lastmodifieddate: '2026-06-01T00:00:00Z' });
    const byMobile = crm.seed('contacts', { phone: '6600110066', lastmodifieddate: '2026-01-01T00:00:00Z' });

    expect((await run(processor, samplePayload())).responseId).toBe(byMobile);
    expect(byEmail).not.toBe(byMobile);
  });
});

describe('Concurrency & HubSpot search lag', () => {
  it('concurrent separate requests for the same mobile create only one contact', async () => {
    const { crm, processor } = setup();
    crm.searchLag = true;
    const results = await Promise.all(Array.from({ length: 5 }, () => processor.processLead(samplePayload())));
    const ids = new Set(results.map((r) => r.responseId));
    expect(ids.size).toBe(1);
    expect(crm.all('contacts')).toHaveLength(1);
  });

  it('recovers when contact create hits the unique-email conflict', async () => {
    const { crm, processor } = setup();
    const existing = crm.seed('contacts', { email: 'testaurum@aa.in' });
    crm.searchLag = true;
    // Hide the seeded contact from search to simulate index lag.
    (crm as unknown as { unsearchable: Set<string> }).unsearchable.add(`contacts:${existing}`);

    const r = await run(processor, samplePayload());
    expect(r).toMatchObject({ status: 200, action: 'EXISTING_CONTACT_UPDATED', responseId: existing });
    expect(crm.all('contacts')).toHaveLength(1);
  });
});

describe('SOP step 5 – campaign attribution', () => {
  const campaignEnv = {
    CAMPAIGN_ENABLED: 'true',
    CAMPAIGN_OBJECT_TYPE: 'p_sf_campaigns',
    CAMPAIGN_ID_PROPERTY: 'sf_campaign_id',
    CAMPAIGN_MEMBER_OBJECT_TYPE: 'p_campaign_member',
  };

  it('creates a campaign member linked to the campaign and contact', async () => {
    const { crm, processor } = setup(campaignEnv);
    const campaignId = crm.seed('p_sf_campaigns', { sf_campaign_id: '701fv00000MD4xKAAT' });

    const r = await run(processor, samplePayload());
    const [member] = crm.all('p_campaign_member');
    expect(member!.properties).toMatchObject({ name: 'Test aurum - 701fv00000MD4xKAAT', status: 'Responded' });
    expect(await crm.associatedIds('p_campaign_member', member!.id, 'p_sf_campaigns')).toEqual([campaignId]);
    expect(await crm.associatedIds('p_campaign_member', member!.id, 'contacts')).toEqual([r.contactId]);
  });

  it('unknown campaign is a warning, not a failure', async () => {
    const { crm, processor } = setup(campaignEnv);
    const r = await run(processor, samplePayload());
    expect(r.status).toBe(200);
    expect(r.warnings.join()).toMatch(/Campaign 701fv00000MD4xKAAT not found/);
    expect(crm.all('p_campaign_member')).toHaveLength(0);
  });
});

describe('SOP §9 – errors', () => {
  it('invalid payload -> 400 VALIDATION_ERROR with message in responseId', async () => {
    const { processor } = setup();
    const r = await run(processor, { firstname: 'x' });
    expect(r).toMatchObject({ status: 400, errorcode: 'VALIDATION_ERROR' });
    expect(r.responseId).toMatch(/mobile or email/);
  });

  it('HubSpot mobile uniqueness conflict -> MOBILE_ALREADY_EXISTS', async () => {
    const { crm, processor } = setup();
    crm.failOn = (op, type) =>
      op === 'create' && type === 'contacts'
        ? new HubSpotError('A contact with phone +916600110066 already exists', 409, {})
        : undefined;
    const r = await run(processor, samplePayload());
    expect(r).toMatchObject({ status: 400, errorcode: 'MOBILE_ALREADY_EXISTS' });
  });

  it('other HubSpot failures -> 400 HUBSPOT_ERROR', async () => {
    const { crm, processor } = setup();
    crm.failOn = (op, type) => (op === 'create' && type === 'contacts' ? new HubSpotError('Internal error', 500, {}) : undefined);
    expect(await run(processor, samplePayload())).toMatchObject({ status: 400, errorcode: 'HUBSPOT_ERROR', responseId: 'Internal error' });
  });

  it('task failure does not fail the request', async () => {
    const { crm, processor } = setup();
    const contactId = crm.seed('contacts', { phone: '+916600110066' });
    crm.failOn = (op, type) => (op === 'create' && type === 'tasks' ? new Error('no scope') : undefined);
    const r = await run(processor, samplePayload());
    expect(r).toMatchObject({ status: 200, responseId: contactId });
    expect(r.warnings.join()).toMatch(/task creation failed/i);
  });
});
