import { MERCHANT_ID_RE, type ApplicationDetailDto } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callbackEvents } from './db/schema.js';
import { events, openTask, sample, sampleFile, startE2E, type E2E } from './e2e.js';

/*
 * The failure scenarios from the brief (docs/PROBLEM.md), one test each,
 * end to end: API + mock providers in-process on random ports, real HTTP and
 * signed callbacks both ways, the worker on a fake clock, callbacks on
 * virtual time (see e2e.ts). Listed in README.md ("Failure scenarios"). Each
 * scenario is also covered in more detail by the phase test files.
 */

let e: E2E;
beforeEach(async () => {
  e = await startE2E();
});
afterEach(() => e.close());

const states = (d: ApplicationDetailDto) => d.audit_log.filter((a) => a.to_state !== null).map((a) => a.to_state);

describe('brief failure scenarios', () => {
  it('SCENARIO 1 - PAN passes, GST fails: IN_REVIEW with reason PAN_OK_GST_FAILED, no approval', async () => {
    const id = await e.submit(sample('gst-fail.json'));
    await e.drain();
    expect(await e.deliver()).toBe(4);
    await e.drain();

    const d = await e.detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.verifications.map((v) => [v.kind, v.status])).toEqual([
      ['PAN', 'PASSED'],
      ['GST', 'FAILED'],
      ['BANK', 'PASSED'],
      ['RISK', 'PASSED'],
    ]);
    expect(openTask(d, 'PAN_OK_GST_FAILED')).toBeDefined();
    expect(events(d, 'VERIFICATION_FAILED')).toHaveLength(1);
    expect(d.merchant_id).toBeNull();
  });

  it('SCENARIO 2 - duplicate callback: second delivery stored as a duplicate and ignored (one effect per event)', async () => {
    await e.setChaos({ duplicateCallback: true });
    const id = await e.submit(sample('happy.json'));
    await e.drain();
    await e.deliver(); // the mock sends every callback twice

    const rows = e.db.select().from(callbackEvents).all();
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.isDuplicate)).toHaveLength(4);
    expect(rows.filter((r) => r.isDuplicate).every((r) => r.note === 'duplicate ignored' && !r.processed)).toBe(true);
    const d = await e.detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(events(d, 'VERIFICATION_RESULT')).toHaveLength(4);
    expect(events(d, 'ALL_CHECKS_PASSED')).toHaveLength(1);

    await e.drain();
    expect((await e.detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 3 - late callback after timeout: recorded as LATE_CALLBACK and reconciled, not lost', async () => {
    // Providers answer after 60s; the API times out at 30s and re-requests; the retries never answer.
    await e.setChaos({ lateCallbackMs: 60_000 });
    const id = await e.submit(sample('happy.json'));
    await e.drain();
    await e.setChaos({ lateCallbackMs: 0, dropCallback: true });

    e.t.clock += e.config.timings.verificationTimeoutMs;
    await e.drain();
    let d = await e.detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(events(d, 'VERIFICATION_TIMED_OUT')).toHaveLength(4);

    expect(await e.deliver(60_000)).toBe(4); // the late answers to attempt 1
    d = await e.detail(id);
    expect(events(d, 'LATE_CALLBACK')).toHaveLength(4);
    expect(d.status).toBe('VERIFIED');

    await e.drain();
    expect((await e.detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 4 - bank details changed after verification: approval blocked (409) until the new account is verified', async () => {
    // high-risk.json stays in IN_REVIEW after VERIFIED, so the operator can try to approve.
    const id = await e.submit(sample('high-risk.json'));
    await e.drain();
    await e.deliver();
    await e.drain();
    let d = await e.detail(id);
    expect(d.status).toBe('IN_REVIEW');
    const task = openTask(d, 'HIGH_RISK');

    await e.api().patch(`/applications/${id}`).send({ bank_account: '60200111122223' }).expect(200);
    d = await e.detail(id);
    expect(d.bank_version).toBe(2);
    expect(d.verifications.find((v) => v.kind === 'BANK' && v.bank_version === 1)).toMatchObject({ superseded: true });

    const blocked = await e.review(id, task.id, 'APPROVE');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('GUARD_FAILED');
    expect(blocked.body.error.message).toContain('BANK');

    await e.drain(); // BANK re-requested for bank_version 2
    expect(await e.deliver()).toBe(1);
    expect((await e.review(id, task.id, 'APPROVE', 'new account verified')).status).toBe(200);
    await e.drain();
    expect((await e.detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 5 - approval OK but merchant ID creation fails: retries, MERCHANT_CREATION_FAILED, operator retry succeeds', async () => {
    await e.api().post('/admin/merchant-service').send({ fail: true }).expect(200);
    const id = await e.submit(sample('happy.json'));
    await e.drain();
    await e.deliver();
    await e.drain();

    let d = await e.detail(id);
    expect(d.status).toBe('MERCHANT_CREATION_FAILED');
    expect(states(d)).toContain('APPROVED');
    expect(d.merchant_id).toBeNull();
    expect(events(d, 'JOB_FAILED')).toHaveLength(2);
    const task = openTask(d, 'MERCHANT_CREATION_FAILED');

    await e.api().post('/admin/merchant-service').send({ fail: false }).expect(200);
    expect((await e.review(id, task.id, 'RETRY_MERCHANT_CREATION', 'service restored')).status).toBe(200);
    await e.drain();
    d = await e.detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.merchant_id).toMatch(MERCHANT_ID_RE);
  });

  it('SCENARIO 6a - conflicting document: PAN card name differs from the form -> IN_REVIEW DOC_CONFLICT, no verification', async () => {
    const id = await e.submit(sample('conflict.json'));
    await e.drain();
    const d = await e.detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(openTask(d, 'DOC_CONFLICT').note).toContain('PAN_CARD.name (name_mismatch');
    expect(d.verifications).toEqual([]);
  });

  it('SCENARIO 6b - blurred document image: blur score below threshold -> IN_REVIEW BLURRY_DOCUMENT, no OCR', async () => {
    const form = sample('ocr-pan.json');
    const res = await e
      .api()
      .post('/applications')
      .field('merchant_name', form.merchant_name)
      .field('pan', form.pan)
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents))
      .attach('PAN_CARD', sampleFile('pan-blurry.png'), { filename: 'pan.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    await e.drain();

    const d = await e.detail(res.body.id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.documents.find((x) => x.type === 'PAN_CARD')!.blur_score).toBeLessThan(e.config.thresholds.blur);
    expect(openTask(d, 'BLURRY_DOCUMENT')).toBeDefined();
    expect(d.verifications).toEqual([]);
  });
});
