import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { callbackEvents } from './db/schema.js';
import { openTask, sample, startE2E, type E2E } from './e2e.js';
import { signBody } from './http/signature.js';
import { createLogger } from './logger.js';

/*
 * Security invariants, kept as tests:
 *  1. transition() is the only writer of applications.status.
 *  2. No raw PAN / GSTIN / bank account in logs or API responses over full
 *     flows (debug-level logs captured).
 *  3. The webhook rejects unsigned / wrongly signed callbacks and stores nothing.
 *  4. Every operator action requires a note.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('1. status is only written by transition()', () => {
  it('no update(applications).set({... status ...}) outside domain/transition.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join('domain', 'transition.ts')) continue;
      const text = readFileSync(file, 'utf8');
      // Each update(applications) call and the .set({...}) that follows it.
      for (const m of text.matchAll(/update\(applications\)\s*\.set\(\{([^}]*)\}/g)) {
        if (/\bstatus\b/.test(m[1]!)) offenders.push(rel);
      }
      // Raw SQL writes to the status column.
      if (/update\s+applications\s+set[^;]*\bstatus\b/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the only other place a status is set is the initial SUBMITTED insert', () => {
    const hits = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('domain', 'transition.ts')))
      .filter((f) => /insert\(applications\)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([join('domain', 'applications.ts')]);
    expect(readFileSync(join(SRC, 'domain', 'applications.ts'), 'utf8')).toMatch(/insert\(applications\)[\s\S]{0,400}status: 'SUBMITTED'/);
  });
});

describe('2. no raw sensitive values in logs or responses', () => {
  let e: E2E | undefined;
  afterEach(async () => {
    await e?.close();
    e = undefined;
  });

  it('happy + gst-fail (operator note containing a PAN) + bank change + duplicate callbacks: nothing raw anywhere', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    e = await startE2E({ logStream: stream, logLevel: 'debug' });
    const happy = sample('happy.json');
    const gstFail = sample('gst-fail.json');
    const highRisk = sample('high-risk.json');
    const raw = [happy, gstFail, highRisk].flatMap((s) => [s.pan, s.gst, s.bank_account]).concat('60200111122223');

    const responses: string[] = [];
    const keep = <T extends { body: unknown }>(r: T) => (responses.push(JSON.stringify(r.body)), r);

    await e.setChaos({ duplicateCallback: true });
    const ids = [await e.submit(happy), await e.submit(gstFail), await e.submit(highRisk)];
    await e.drain();
    await e.deliver();
    await e.drain();

    // Operator note with a raw PAN in it; merchant changes bank details.
    const gst = await e.detail(ids[1]!);
    keep(await e.review(ids[1]!, openTask(gst, 'PAN_OK_GST_FAILED').id, 'REJECT', `fake docs, PAN ${gstFail.pan}`));
    keep(await e.api().patch(`/applications/${ids[2]}`).send({ bank_account: '60200111122223' }));
    await e.drain();

    for (const id of ids) keep(await e.api().get(`/applications/${id}`));
    keep(await e.api().get('/applications'));
    keep(await e.api().get('/review-tasks?status=OPEN'));
    keep(await e.api().get('/review-tasks?status=RESOLVED'));
    keep(await e.api().get('/jobs?status=dead'));

    expect(lines.length).toBeGreaterThan(20); // debug logs were really captured
    const logs = lines.join('');
    const body = responses.join('\n');
    for (const value of raw) {
      expect(logs, `log contains ${value.slice(-4)}`).not.toContain(value);
      expect(body, `response contains ${value.slice(-4)}`).not.toContain(value);
    }
  });
});

describe('3. webhook signature', () => {
  let e: E2E | undefined;
  afterEach(async () => {
    await e?.close();
    e = undefined;
  });

  it('missing, wrong-secret and tampered signatures are 401 and nothing is stored', async () => {
    e = await startE2E();
    const body = JSON.stringify({
      event_id: 'evt-1',
      request_id: 'req-1',
      kind: 'PAN',
      result: { status: 'PASSED' },
      application_ref: 'app-x',
    });
    const post = (sig?: string, payload = body) => {
      const r = e!.api().post('/webhooks/provider').set('content-type', 'application/json');
      return (sig ? r.set('X-Signature', sig) : r).send(payload);
    };
    expect((await post()).status).toBe(401);
    expect((await post(signBody('not-the-secret', body))).status).toBe(401);
    expect((await post(signBody(e.secret, body), body.replace('PASSED', 'FAILED'))).status).toBe(401);
    expect((await post('sha256=zz')).status).toBe(401);
    expect(e.db.select().from(callbackEvents).all()).toEqual([]);

    expect((await post(signBody(e.secret, body))).status).toBe(200); // control: the right signature is accepted
  });
});

describe('4. every operator action requires a note', () => {
  let e: E2E | undefined;
  afterEach(async () => {
    await e?.close();
    e = undefined;
  });

  it.each(['APPROVE', 'REJECT', 'REQUEST_INFO', 'RETRY_VERIFICATION', 'RETRY_MERCHANT_CREATION', 'DISMISS'])(
    '%s without a note (or with < 5 chars) is 400 and changes nothing',
    async (resolution) => {
      e = await startE2E();
      const id = await e.submit(sample('conflict.json'));
      await e.drain();
      const task = openTask(await e.detail(id), 'DOC_CONFLICT');
      for (const body of [{ taskId: task.id, resolution }, { taskId: task.id, resolution, note: ' ok ' }]) {
        const res = await e.api().post(`/applications/${id}/review`).send(body);
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain('Note is required');
      }
      const d = await e.detail(id);
      expect(d.status).toBe('IN_REVIEW');
      expect(openTask(d, 'DOC_CONFLICT').id).toBe(task.id);
    },
  );

  it('dead-letter requeue without a note is 400', async () => {
    e = await startE2E();
    const res = await e.api().post('/jobs/1/requeue').send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Note is required');
  });
});

describe('5. demo reset endpoint', () => {
  let e: E2E | undefined;
  afterEach(async () => {
    await e?.close();
    e = undefined;
  });

  it('POST /admin/reset-data wipes every table in DEMO_MODE', async () => {
    e = await startE2E();
    await e.submit(sample('happy.json'));
    await e.drain();
    await e.api().post('/admin/merchant-service').send({ fail: true }).expect(200);
    const res = await e.api().post('/admin/reset-data').expect(200);
    expect(res.body.deleted.applications).toBe(1);
    expect((await e.api().get('/applications')).body.count).toBe(0);
    expect((await e.api().get('/admin/merchant-service')).body).toEqual({ fail: false });
  });

  it('is 404 when DEMO_MODE is off', async () => {
    const db = openDb(':memory:');
    const app = createApp({ config: loadConfig({ DB_PATH: ':memory:', DEMO_MODE: 'false' }), logger: createLogger({ level: 'silent' }), db });
    await request(app).post('/admin/reset-data').expect(404);
    db.$client.close();
  });
});
