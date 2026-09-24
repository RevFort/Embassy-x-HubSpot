import { pino } from 'pino';
import { loadConfig, loadFieldMapping } from '../src/config.js';
import { LeadProcessor } from '../src/service/leadProcessor.js';
import { FakeCrm } from './fakeCrm.js';

export const TEST_CLIENT_ID = 'test-client';
export const TEST_CLIENT_SECRET = 'test-secret-0123456789abcdef0123456789';

export const silentLog = pino({ level: 'silent' });

export function setup(env: Record<string, string> = {}) {
  const crm = new FakeCrm();
  const cfg = loadConfig({
    OAUTH_CLIENT_ID: TEST_CLIENT_ID,
    OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
    TOKEN_SIGNING_SECRET: 'test-signing-secret-0123456789abcdef',
    ...env,
  });
  const mapping = loadFieldMapping('config/field-mapping.json');
  const processor = new LeadProcessor(crm, cfg, mapping, silentLog);
  return { crm, cfg, processor };
}

/** The sample payload the agency (Aurum) sends. */
export const samplePayload = (overrides: Record<string, unknown> = {}) => ({
  firstname: 'Test',
  lastname: 'aurum',
  mobile: '6600110066',
  email: 'testaurum@aa.in',
  countrycode: '+91',
  Project_interested: 'Embassy South Reserve',
  LeadSource: 'Digital Marketing',
  modeofenquiry: 'Web',
  subsource: 'Social Media',
  owner: 'LMT Queue',
  Medium: 'Webzaa',
  Term: '',
  comments: 'Comfortable with Budget: yes | Comfortable with Location: yes',
  campaignId: '701fv00000MD4xKAAT',
  enquiryDate: '2026-05-12',
  utm_ssc: 'Facebook',
  ...overrides,
});
