import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { requireBearer, tokenEndpoint, TokenService } from './auth.js';
import type { AppConfig } from './config.js';
import type { IntegrationLog } from './integrationLog.js';
import type { LeadProcessor, LeadResult } from './service/leadProcessor.js';

interface Deps {
  cfg: AppConfig;
  processor: LeadProcessor;
  integrationLog: IntegrationLog;
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

export function createApp({ cfg, processor, integrationLog, log }: Deps) {
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
