import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { requireBearer, tokenEndpoint, TokenService } from './auth.js';
import type { AppConfig } from './config.js';
import type { IntegrationLog } from './integrationLog.js';
import { verifyHubSpotSignature } from './hubspot/webhookSignature.js';
import type { ConversionForwarder, HubSpotWebhookEvent } from './service/conversionForwarder.js';
import type { LeadProcessor, LeadResult } from './service/leadProcessor.js';
import { tracer, withRequest } from './trace.js';

const trace = tracer('src/app.ts');

interface Deps {
  cfg: AppConfig;
  processor: LeadProcessor;
  integrationLog: IntegrationLog;
  forwarder: ConversionForwarder;
  conversionLog: IntegrationLog;
  log: Logger;
}

/** What the agency sees: the SOP §5 response contract. */
const toResponse = (r: LeadResult) => ({
  responseId: r.responseId,
  status: r.status,
  ...(r.errorcode ? { errorcode: r.errorcode } : {}),
  ...(r.action ? { action: r.action } : {}),
});

const badRequest = (res: Response, message: string, errorcode = 'VALIDATION_ERROR') =>
  res.status(400).json({ responseId: message, status: 400, errorcode });

export function createApp({ cfg, processor, integrationLog, forwarder, conversionLog, log }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const tokens = new TokenService([{ id: cfg.oauth.clientId, secret: cfg.oauth.clientSecret }], cfg.oauth.signingSecret, cfg.oauth.tokenTtlSeconds);
  app.post('/oauth2/token', ...tokenEndpoint(tokens));

  app.post('/api/v1/leads', requireBearer(tokens), express.json({ limit: '2mb' }), async (req, res) => {
    const started = Date.now();
    const requestId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    const result = await processor.processLead(req.body);
    await integrationLog.write({
      requestId,
      payload: req.body,
      status: result.status,
      responseId: result.responseId,
      errorcode: result.errorcode,
      action: result.action,
      contactId: result.contactId,
      warnings: result.warnings,
      durationMs: Date.now() - started,
    });

    return res.status(result.status).json(toResponse(result));
  });

  /**
   * HubSpot webhook (contact.propertyChange). Verified, acknowledged immediately (HubSpot times out at 5s and
   * retries on failure), then each event is looked up and forwarded to Aurum in the background.
   */
  app.post('/webhooks/hubspot', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const requestId = req.get('x-request-id') ?? randomUUID();
    withRequest(requestId, () => handleWebhook(requestId, req, res));
  });

  const handleWebhook = (requestId: string, req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const wh = cfg.conversions;
    trace('webhook request received', {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      bytes: rawBody.length,
      headers: {
        'user-agent': req.get('user-agent'),
        'content-type': req.get('content-type'),
        'x-hubspot-signature-version': req.get('x-hubspot-signature-version'),
        'x-hubspot-request-timestamp': req.get('x-hubspot-request-timestamp'),
        'x-hubspot-signature-v3': req.get('x-hubspot-signature-v3'),
        'x-hubspot-signature': req.get('x-hubspot-signature'),
      },
      body: rawBody,
    });
    const ok = verifyHubSpotSignature({
      secret: wh.webhookSecret,
      method: req.method,
      url: `${wh.publicBaseUrl}${req.originalUrl}`,
      rawBody,
      v3Signature: req.get('x-hubspot-signature-v3'),
      v3Timestamp: req.get('x-hubspot-request-timestamp'),
      v1Signature: req.get('x-hubspot-signature'),
    });
    if (!ok) {
      log.warn({ ip: req.ip }, 'HubSpot webhook signature rejected');
      trace('responding 401 invalid signature');
      return res.status(401).json({ success: false, error: 'invalid signature' });
    }

    let events: HubSpotWebhookEvent[];
    try {
      const parsed: unknown = JSON.parse(rawBody);
      events = Array.isArray(parsed) ? parsed : [parsed as HubSpotWebhookEvent];
    } catch {
      trace('responding 400 invalid JSON');
      return res.status(400).json({ success: false, error: 'invalid JSON' });
    }

    trace('authenticated; responding 200 and processing in background', { events: events.length });
    res.status(200).json({ success: true, received: events.length });

    void (async () => {
      for (const event of events) {
        const r = await forwarder.forward(event);
        await conversionLog.write({
          requestId,
          payload: event,
          status: r.outcome === 'failed' ? 502 : 200,
          responseId: r.aurumId ?? r.reason ?? r.outcome,
          action: `${r.outcome}${r.eventName ? ` ${r.eventName}` : ''}`,
          contactId: r.contactId,
          warnings: r.reason ? [r.reason] : [],
          durationMs: r.durationMs,
        });
        trace('event processed and written to conversions log', { eventId: event.eventId, outcome: r.outcome });
      }
    })().catch((err) => log.error({ err }, 'Webhook processing crashed'));
  };

  app.use((_req, res) => {
    res.status(404).json({ responseId: 'Not found', status: 404, errorcode: 'NOT_FOUND' });
  });

  // Malformed JSON and anything unexpected still answer in the SOP response shape.
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return badRequest(res, 'Invalid JSON body');
    if (err.type === 'entity.too.large') return badRequest(res, 'Request body too large');
    log.error({ err }, 'Unhandled error');
    res.status(500).json({ responseId: 'Internal server error', status: 500, errorcode: 'INTERNAL_ERROR' });
  });

  return app;
}
