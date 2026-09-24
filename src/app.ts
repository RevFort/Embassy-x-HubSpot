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
  ...(r.sameTransactionDuplicateOf !== undefined ? { sameTransactionDuplicateOf: r.sameTransactionDuplicateOf } : {}),
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

    const isBatch = Array.isArray(req.body);
    const inputs: unknown[] = isBatch ? req.body : [req.body];
    if (inputs.length === 0 || req.body === undefined) return badRequest(res, 'Request body must be a lead object or a non-empty array of leads');
    if (inputs.length > cfg.maxBatchSize) return badRequest(res, `At most ${cfg.maxBatchSize} leads per request`);

    const results = await processor.processBatch(inputs);
    await integrationLog.write(
      results.map((r, index) => ({
        requestId,
        index,
        payload: inputs[index],
        status: r.status,
        responseId: r.responseId,
        errorcode: r.errorcode,
        action: r.action,
        contactId: r.contactId,
        sameTransactionDuplicateOf: r.sameTransactionDuplicateOf,
        warnings: r.warnings,
        durationMs: Date.now() - started,
      })),
    );

    if (isBatch) return res.status(200).json(results.map(toResponse));
    const [single] = results;
    return res.status(single!.status).json(toResponse(single!));
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
