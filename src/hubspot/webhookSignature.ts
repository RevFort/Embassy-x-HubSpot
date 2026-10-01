import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

import { tracer } from '../trace.js';

const trace = tracer('src/hubspot/webhookSignature.ts');

const MAX_AGE_MS = 5 * 60 * 1000;

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyHubSpotSignature(opts: {
  secret: string;
  method: string;
  url: string;
  rawBody: string;
  v3Signature?: string;
  v3Timestamp?: string;
  v1Signature?: string;
  now?: number;
}): boolean {
  const { secret, rawBody } = opts;
  if (opts.v3Signature && opts.v3Timestamp) {
    const age = (opts.now ?? Date.now()) - Number(opts.v3Timestamp);
    trace('verifying v3 signature', { method: opts.method, signedUrl: opts.url, timestamp: opts.v3Timestamp, ageMs: age, maxAgeMs: MAX_AGE_MS });
    if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
      trace('signature rejected: timestamp outside allowed window');
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${opts.method}${opts.url}${rawBody}${opts.v3Timestamp}`)
      .digest('base64');
    const valid = equal(expected, opts.v3Signature);
    trace(valid ? 'v3 signature valid' : 'signature rejected: v3 HMAC mismatch (check HUBSPOT_WEBHOOK_SECRET / PUBLIC_BASE_URL)', {
      received: opts.v3Signature,
    });
    return valid;
  }
  if (opts.v1Signature) {
    const valid = equal(createHash('sha256').update(secret + rawBody).digest('hex'), opts.v1Signature);
    trace(valid ? 'v1 signature valid' : 'signature rejected: v1 hash mismatch', { received: opts.v1Signature });
    return valid;
  }
  trace('signature rejected: no v3 (signature + timestamp) or v1 signature header present');
  return false;
}
