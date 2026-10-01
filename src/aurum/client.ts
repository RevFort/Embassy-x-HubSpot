import type { Logger } from 'pino';
import { tracer } from '../trace.js';

const trace = tracer('src/aurum/client.ts');

export interface AurumPayload {
  phone_sha256: string;
  phone_sha256_e164: string;
  email_sha256?: string;
  event_name: string;
  project_name: string;
  source: string;
  event_time: string | number;
  event_id: string;
  lead_id?: string;
  gclid?: string;
  lead_remark?: string;
  value?: number;
  currency?: string;
}

export interface AurumResult {
  httpStatus: number;
  success: boolean;
  id?: string;
  routedTo?: string | null;
  delivery?: { status: string; attempts: number; error: string | null };
  error?: string;
}

export interface Aurum {
  send(payload: AurumPayload): Promise<AurumResult>;
}

export class AurumClient implements Aurum {
  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; timeoutMs: number; maxRetries: number },
    private readonly log: Logger,
  ) {}
  
  async send(payload: AurumPayload): Promise<AurumResult> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let networkError: string | undefined;
      const url = `${this.opts.baseUrl}/api/v1/leads`;
      trace('aurum request', { attempt, method: 'POST', url, payload });
      try {
        res = await fetch(`${this.opts.baseUrl}/api/v1/leads`, {
          method: 'POST',
          headers: { 'X-API-Key': this.opts.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        networkError = (err as Error).message;
      }

      if (res && res.status !== 503) {
        const body = await readJson(res);
        trace('aurum response', { attempt, status: res.status, body });
        return toResult(res.status, body);
      }
      trace('aurum retryable failure', { attempt, status: res?.status, networkError });

      if (attempt >= this.opts.maxRetries) {
        return { httpStatus: res?.status ?? 0, success: false, error: networkError ?? 'Aurum unavailable (503)' };
      }
      const wait = Math.min(500 * 2 ** attempt, 8000);
      this.log.warn({ attempt, wait, networkError, status: res?.status }, 'Aurum retryable error');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function readJson(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function toResult(httpStatus: number, body: Record<string, any>): AurumResult {
  const delivery = body.routed_to ? body.deliveries?.[body.routed_to] : undefined;
  const fields = body.fields ? ` ${JSON.stringify(body.fields)}` : '';
  return {
    httpStatus,
    success: body.success === true,
    id: body.id,
    routedTo: body.routed_to,
    delivery,
    ...(body.success === true ? {} : { error: `${body.error ?? `HTTP ${httpStatus}`}${fields}` }),
  };
}
