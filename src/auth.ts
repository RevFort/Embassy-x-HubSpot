import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';

export interface OAuthClient {
  id: string;
  secret: string;
}

interface TokenClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time string compare that doesn't leak length. */
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/**
 * Issues and verifies stateless access tokens (`<base64url claims>.<base64url HMAC-SHA256>`).
 * Tokens survive restarts and work across instances. Removing a client from config revokes its tokens.
 */
export class TokenService {
  constructor(
    private readonly clients: OAuthClient[],
    private readonly signingSecret: string,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the client ID if the credentials are valid. Every client is compared, so timing doesn't reveal which IDs exist. */
  authenticate(clientId: string, clientSecret: string): string | undefined {
    let match: string | undefined;
    for (const c of this.clients) {
      if (safeEqual(c.id, clientId) && safeEqual(c.secret, clientSecret)) match = c.id;
    }
    return match;
  }

  issue(clientId: string) {
    const iat = this.now();
    const claims: TokenClaims = { sub: clientId, iat, exp: iat + this.ttlSeconds * 1000, jti: randomUUID() };
    const body = b64url(JSON.stringify(claims));
    return {
      access_token: `${body}.${this.sign(body)}`,
      token_type: 'Bearer',
      expires_in: this.ttlSeconds,
      issued_at: String(iat),
    };
  }

  /** Returns the token's client ID, or undefined if it is malformed, forged, expired, or its client was removed. */
  verify(token: string): string | undefined {
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined || !safeEqual(sig, this.sign(body))) return undefined;
    let claims: TokenClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (typeof claims.exp !== 'number' || claims.exp <= this.now()) return undefined;
    return this.clients.some((c) => c.id === claims.sub) ? claims.sub : undefined;
  }

  private sign(body: string) {
    return createHmac('sha256', this.signingSecret).update(body).digest('base64url');
  }
}

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).set('cache-control', 'no-store').json({ error, error_description: description });

/** Client credentials from the body, or from an HTTP Basic header (RFC 6749 §2.3.1). */
function clientCredentials(req: Request): { id: string; secret: string } | undefined {
  const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return undefined;
    return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  }
  const { client_id, client_secret } = (req.body ?? {}) as Record<string, unknown>;
  return typeof client_id === 'string' && typeof client_secret === 'string' ? { id: client_id, secret: client_secret } : undefined;
}

/** `POST` handler for the OAuth 2.0 client-credentials token endpoint. Accepts form-encoded or JSON bodies. */
export function tokenEndpoint(tokens: TokenService) {
  return [
    express.urlencoded({ extended: false, limit: '10kb' }),
    express.json({ limit: '10kb' }),
    (req: Request, res: Response) => {
      const grantType = (req.body as Record<string, unknown> | undefined)?.grant_type;
      if (grantType !== 'client_credentials') {
        return oauthError(res, 400, 'unsupported_grant_type', 'grant_type must be client_credentials');
      }
      const creds = clientCredentials(req);
      const clientId = creds && tokens.authenticate(creds.id, creds.secret);
      if (!clientId) return oauthError(res, 401, 'invalid_client', 'invalid client credentials');
      res.set('cache-control', 'no-store').json(tokens.issue(clientId));
    },
  ];
}

/** Requires `Authorization: Bearer <access_token>` from the token endpoint. */
export function requireBearer(tokens: TokenService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    const clientId = match && tokens.verify(match[1]!);
    if (clientId) {
      res.locals.clientId = clientId;
      return next();
    }
    res
      .status(401)
      .set('www-authenticate', match ? 'Bearer error="invalid_token"' : 'Bearer')
      .json({ responseId: 'Unauthorized', status: 401, errorcode: 'UNAUTHORIZED' });
  };
}
