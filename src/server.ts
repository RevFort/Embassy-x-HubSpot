import { pino } from 'pino';
import { createApp } from './app.js';
import { AurumClient } from './aurum/client.js';
import { loadConfig, loadConversionEvents, loadFieldMapping } from './config.js';
import { HubSpotCrm } from './hubspot/client.js';
import { IntegrationLog } from './integrationLog.js';
import { ConversionForwarder } from './service/conversionForwarder.js';
import { LeadProcessor } from './service/leadProcessor.js';

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: ['req.headers.authorization', 'req.body.client_secret'] });

if (!cfg.hubspot.accessToken) throw new Error('HUBSPOT_ACCESS_TOKEN is required');
if (!cfg.oauth.clientId) throw new Error('OAUTH_CLIENT_ID is required');
if (cfg.oauth.clientSecret.length < 32) throw new Error('OAUTH_CLIENT_SECRET is required (at least 32 characters)');
if (cfg.oauth.signingSecret.length < 32) throw new Error('TOKEN_SIGNING_SECRET is required (at least 32 characters)');

if (!cfg.conversions.webhookSecret) throw new Error('HUBSPOT_WEBHOOK_SECRET is required (app client secret, verifies webhook signatures)');
if (!cfg.conversions.publicBaseUrl) throw new Error('PUBLIC_BASE_URL is required (the signed webhook URL, e.g. https://api.example.com)');
if (!cfg.conversions.aurum.apiKey) throw new Error('AURUM_API_KEY is required');

const mapping = loadFieldMapping(cfg.fieldMappingPath);
const crm = new HubSpotCrm(cfg.hubspot, log);

const processor = new LeadProcessor(crm, cfg, mapping, log);
const integrationLog = new IntegrationLog(cfg.integrationLog.dir, cfg.integrationLog.includePayload, log);
const aurum = new AurumClient(cfg.conversions.aurum, log);
const forwarder = new ConversionForwarder(crm, aurum, cfg, loadConversionEvents(cfg.conversions.eventsPath), log);
const conversionLog = new IntegrationLog(cfg.integrationLog.dir, cfg.integrationLog.includePayload, log, 'conversions');
const server = createApp({ cfg, processor, integrationLog, forwarder, conversionLog, log }).listen(cfg.port, () => {
  log.info({ port: cfg.port }, 'Marketing Lead API listening');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
