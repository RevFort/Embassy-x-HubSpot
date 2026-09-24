import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { IntegrationLog } from '../src/integrationLog.js';
import { samplePayload, setup, silentLog, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './helpers.js';

async function makeApp(env: Record<string, string> = {}) {
  const { crm, cfg, processor } = setup(env);
  const dir = mkdtempSync(join(tmpdir(), 'intlog-'));
  const app = createApp({ cfg, processor, integrationLog: new IntegrationLog(dir, true, silentLog), log: silentLog });
  const res = await request(app)
    .post('/oauth2/token')
    .type('form')
    .send({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET })
    .expect(200);
  return { app, crm, dir, auth: `Bearer ${res.body.access_token}` };
}

describe('POST /oauth2/token', () => {
  it('issues a bearer token for valid client credentials (form or JSON)', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/oauth2/token')
      .send({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET })
      .expect(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, access_token: expect.any(String), issued_at: expect.any(String) });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts HTTP Basic client authentication', async () => {
    const { app } = await makeApp();
    await request(app)
      .post('/oauth2/token')
      .auth(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
      .type('form')
      .send({ grant_type: 'client_credentials' })
      .expect(200);
  });

  it('rejects wrong credentials and other grant types', async () => {
    const { app } = await makeApp();
    const bad = await request(app)
      .post('/oauth2/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: 'wrong' })
      .expect(401);
    expect(bad.body.error).toBe('invalid_client');
    const grant = await request(app).post('/oauth2/token').type('form').send({ grant_type: 'password' }).expect(400);
    expect(grant.body.error).toBe('unsupported_grant_type');
  });
});

describe('POST /api/v1/leads', () => {
  it('rejects missing, forged, or tampered bearer tokens', async () => {
    const { app, auth } = await makeApp();
    await request(app).post('/api/v1/leads').send(samplePayload()).expect(401);
    await request(app).post('/api/v1/leads').set('authorization', 'Bearer nope').send(samplePayload()).expect(401);
    const [body, sig] = auth.slice('Bearer '.length).split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 1e9 })).toString('base64url');
    const res = await request(app).post('/api/v1/leads').set('authorization', `Bearer ${forged}.${sig}`).send(samplePayload()).expect(401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  it('rejects expired tokens', async () => {
    const { app, auth } = await makeApp({ ACCESS_TOKEN_TTL_SECONDS: '-1' });
    await request(app).post('/api/v1/leads').set('authorization', auth).send(samplePayload()).expect(401);
  });

  it('single lead -> SOP response shape, and writes the integration log', async () => {
    const { app, crm, dir, auth } = await makeApp();
    const res = await request(app).post('/api/v1/leads').set('authorization', auth).send(samplePayload()).expect(200);
    expect(res.body).toEqual({ responseId: crm.all('contacts')[0]!.id, status: 200, action: 'NEW_CONTACT_CREATED' });

    const [file] = readdirSync(dir);
    const entry = JSON.parse(readFileSync(join(dir, file!), 'utf8').trim());
    expect(entry).toMatchObject({ status: 200, action: 'NEW_CONTACT_CREATED', payload: { utm_ssc: 'Facebook' } });
  });

  it('invalid single lead -> HTTP 400', async () => {
    const { app, auth } = await makeApp();
    const res = await request(app).post('/api/v1/leads').set('authorization', auth).send({ lastname: 'x' }).expect(400);
    expect(res.body).toMatchObject({ status: 400, errorcode: 'VALIDATION_ERROR' });
  });

  it('malformed JSON -> 400 in SOP shape', async () => {
    const { app, auth } = await makeApp();
    const res = await request(app)
      .post('/api/v1/leads')
      .set('authorization', auth)
      .set('content-type', 'application/json')
      .send('{"mobile":')
      .expect(400);
    expect(res.body).toEqual({ responseId: 'Invalid JSON body', status: 400, errorcode: 'VALIDATION_ERROR' });
  });

  it('array body -> 400', async () => {
    const { app, auth } = await makeApp();
    await request(app).post('/api/v1/leads').set('authorization', auth).send([samplePayload()]).expect(400);
  });
});
