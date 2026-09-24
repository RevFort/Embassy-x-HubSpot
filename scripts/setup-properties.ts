/**
 * Creates the custom HubSpot properties this service writes to, if they don't exist yet.
 *
 *   npm run setup:properties            # dry run: prints what would be created
 *   npm run setup:properties -- --apply # creates them
 *
 * Needs HUBSPOT_ACCESS_TOKEN with crm.schemas.contacts.write (and read) scopes.
 */
import { loadConfig, loadFieldMapping } from '../src/config.js';

type Kind = 'string' | 'textarea' | 'date' | 'datetime' | 'number' | 'phone';
const FIELD: Record<Kind, { type: string; fieldType: string }> = {
  string: { type: 'string', fieldType: 'text' },
  textarea: { type: 'string', fieldType: 'textarea' },
  phone: { type: 'string', fieldType: 'phonenumber' },
  date: { type: 'date', fieldType: 'date' },
  datetime: { type: 'datetime', fieldType: 'date' },
  number: { type: 'number', fieldType: 'number' },
};
const GROUP = 'marketing_lead_api';

const cfg = loadConfig();
const apply = process.argv.includes('--apply');
const mapping = loadFieldMapping(cfg.fieldMappingPath);
if (!cfg.hubspot.accessToken) throw new Error('HUBSPOT_ACCESS_TOKEN is required');

const wanted: Record<'contacts', Map<string, Kind>> = { contacts: new Map() };
for (const f of mapping.fields) for (const t of f.targets) wanted.contacts.set(t.property, t.type);
const id = cfg.identity;
for (const p of [id.alternateMobile, id.alternateLandline]) wanted.contacts.set(p, 'phone');
wanted.contacts.set(id.alternateEmail, 'string');
const t = cfg.tracking;
if (t.reEnquiryCountProperty) wanted.contacts.set(t.reEnquiryCountProperty, 'number');
if (t.lastEnquiryAtProperty) wanted.contacts.set(t.lastEnquiryAtProperty, 'datetime');
if (t.rawPayloadProperty) wanted.contacts.set(t.rawPayloadProperty, 'textarea');

async function hs<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.hubspot.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.hubspot.accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const label = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

for (const [objectType, props] of Object.entries(wanted)) {
  const existing = new Set((await hs<{ results: { name: string }[] }>('GET', `/crm/v3/properties/${objectType}`)).results.map((p) => p.name));
  const missing = [...props].filter(([name]) => !existing.has(name));
  if (!missing.length) {
    console.log(`${objectType}: all ${props.size} properties exist`);
    continue;
  }
  console.log(`${objectType}: ${apply ? 'creating' : 'would create'} ${missing.map(([n, k]) => `${n} (${k})`).join(', ')}`);
  if (!apply) continue;

  const groups = (await hs<{ results: { name: string }[] }>('GET', `/crm/v3/properties/${objectType}/groups`)).results;
  if (!groups.some((g) => g.name === GROUP)) {
    await hs('POST', `/crm/v3/properties/${objectType}/groups`, { name: GROUP, label: 'Marketing Lead API' });
  }
  for (const [name, kind] of missing) {
    await hs('POST', `/crm/v3/properties/${objectType}`, { name, label: label(name), groupName: GROUP, ...FIELD[kind] });
    console.log(`  created ${objectType}.${name}`);
  }
}
if (!apply) console.log('\nDry run only. Re-run with --apply to create them.');
