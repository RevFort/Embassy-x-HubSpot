import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

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
    if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) return false;
    const expected = createHmac('sha256', secret)
      .update(`${opts.method}${opts.url}${rawBody}${opts.v3Timestamp}`)
      .digest('base64');
    return equal(expected, opts.v3Signature);
  }
  if (opts.v1Signature) {
    return equal(createHash('sha256').update(secret + rawBody).digest('hex'), opts.v1Signature);
  }
  return false;
}
