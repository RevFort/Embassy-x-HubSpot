import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig, loadFieldMapping } from './config.js';
import { HubSpotCrm } from './hubspot/client.js';
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
