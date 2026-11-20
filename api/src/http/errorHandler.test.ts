import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { GuardError, NotFoundError } from '../errors.js';
import { createLogger } from '../logger.js';

const PAN = 'ABCDE1234F';
const ACCT = '123456789012';

function makeApp() {
  const logs: string[] = [];
  const stream = new Writable({
    write(c, _e, cb) {
      logs.push(c.toString());
      cb();
    },
  });
  const app = createApp({
    config: loadConfig({ DB_PATH: ':memory:' }),
    logger: createLogger({ level: 'debug', stream }),
    db: openDb(':memory:'),
    mount(app) {
      app.get('/boom', async () => {
        await Promise.resolve();
        throw new Error(`db exploded on pan=${PAN} acct=${ACCT}`);
      });
      app.get('/guard', async () => {
        throw new GuardError(`cannot approve ${PAN}: BANK not passed`);
      });
      app.get('/missing', () => {
        throw new NotFoundError('Application not found');
      });
      app.post('/validate', (req, res) => {
        const body = z.object({ pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/) }).parse(req.body);
        res.json(body);
      });
    },
  });
  return { app, logs };
}

describe('central error handler', () => {
  it('serves /health', async () => {
    const res = await request(makeApp().app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'api' });
  });

  it('turns async throws into a generic 500 without leaking raw values', async () => {
    const { app, logs } = makeApp();
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    const all = JSON.stringify(res.body) + logs.join('');
    expect(all).not.toContain(PAN);
    expect(all).not.toContain(ACCT);
  });

  it('maps GuardError to 409 and masks the message', async () => {
    const res = await request(makeApp().app).get('/guard');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GUARD_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });

  it('maps NotFoundError and unknown routes to 404', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/missing')).status).toBe(404);
    expect((await request(app).get('/nope')).status).toBe(404);
  });

  it('maps ZodError to 400 without echoing the input', async () => {
    const res = await request(makeApp().app).post('/validate').send({ pan: 'abcde12345678901' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('pan');
    expect(JSON.stringify(res.body)).not.toContain('abcde12345678901');
  });

  it('rejects malformed JSON without quoting the body', async () => {
    const { app, logs } = makeApp();
    const res = await request(app)
      .post('/validate')
      .set('content-type', 'application/json')
      .send(`{"pan":"${PAN}","bank_account":"${ACCT}",`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Malformed JSON body');
    const all = JSON.stringify(res.body) + logs.join('');
    expect(all).not.toContain(PAN);
    expect(all).not.toContain(ACCT);
  });
});
