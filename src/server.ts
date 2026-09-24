import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig, loadFieldMapping, type AppConfig, type FieldMapping } from './config.js';
import { HubSpotCrm, type Crm } from './hubspot/client.js';
import { IntegrationLog } from './integrationLog.js';
import { LeadProcessor } from './service/leadProcessor.js';

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: ['req.headers.authorization', 'req.body.client_secret'] });

if (!cfg.hubspot.accessToken) throw new Error('HUBSPOT_ACCESS_TOKEN is required');
if (!cfg.oauth.clientId) throw new Error('OAUTH_CLIENT_ID is required');
if (cfg.oauth.clientSecret.length < 32) throw new Error('OAUTH_CLIENT_SECRET is required (at least 32 characters)');
if (cfg.oauth.signingSecret.length < 32) throw new Error('TOKEN_SIGNING_SECRET is required (at least 32 characters)');

const mapping = loadFieldMapping(cfg.fieldMappingPath);
const crm = new HubSpotCrm(cfg.hubspot, log);

await reportMissingProperties(crm, cfg, mapping);

const processor = new LeadProcessor(crm, cfg, mapping, log);
const integrationLog = new IntegrationLog(cfg.integrationLog.dir, cfg.integrationLog.includePayload, log);
const server = createApp({ cfg, processor, integrationLog, log }).listen(cfg.port, () => {
  log.info({ port: cfg.port }, 'Marketing Lead API listening');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

/** Warn at startup (don't crash) about configured properties that don't exist in the portal. */
async function reportMissingProperties(crm: Crm, cfg: AppConfig, mapping: FieldMapping) {
  const t = cfg.tracking;
  const wanted: Record<string, string[]> = {
    contacts: [
      ...Object.values(cfg.identity),
      t.reEnquiryCountProperty,
      t.lastEnquiryAtProperty,
      t.rawPayloadProperty,
      ...mapping.fields.flatMap((f) => f.targets.map((target) => target.property)),
    ],
  };
  for (const [objectType, props] of Object.entries(wanted)) {
    try {
      const existing = await crm.propertyNames(objectType);
      const missing = [...new Set(props.filter(Boolean))].filter((p) => !existing.has(p));
      if (missing.length) {
        log.warn({ objectType, missing }, 'Configured HubSpot properties do not exist; run `npm run setup:properties`');
      }
    } catch (err) {
      log.error({ err, objectType }, 'Could not read HubSpot properties at startup (check token scopes)');
    }
  }
}
