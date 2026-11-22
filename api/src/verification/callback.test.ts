import type { ProviderCallback, VerificationKind } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { applications, callbackEvents, verifications } from '../db/schema.js';
import type { ProviderClient } from '../providers/client.js';
import { createFakeProviderClient, type FakeProviderClient } from '../providers/fake.js';
import { receiveCallback } from './callback.js';
import { currentVerification } from './latest.js';
import { runStartVerifications } from './start.js';
import { appRow, auditOf, makeEnv, rowsOf, T0, verifyingApp } from './testkit.js';

let env: ReturnType<typeof makeEnv>;
let db: Db;
let fake: FakeProviderClient;
let evt = 0;

beforeEach(async () => {
  env = makeEnv();
  db = env.db;
  fake = createFakeProviderClient();
  evt = 0;
});
afterEach(() => db.$client.close());

async function started() {
  verifyingApp(db);
  await runStartVerifications({ ...env, now: T0 }, fake, 'app-1');
}

const cbFor = (kind: VerificationKind, over: Partial<ProviderCallback> = {}): ProviderCallback => ({
  event_id: `evt-${++evt}`,
  request_id: fake.last(kind)!.request_id,
  kind,
  result: kind === 'RISK' ? { status: 'PASSED', score: 12 } : { status: 'PASSED' },
  application_ref: 'app-1',
  ...(kind === 'BANK' ? { bank_version: 1 } : {}),
  ...over,
});

const receive = (cb: ProviderCallback, now = T0 + 5_000) => receiveCallback({ ...env, now }, cb);
const row = (kind: VerificationKind) => rowsOf(db).filter((r) => r.kind === kind);
const events = () => db.select().from(callbackEvents).orderBy(callbackEvents.id).all();
const nonRequestAudit = () => auditOf(db).filter((a) => !['VERIFICATION_REQUESTED'].includes(a.event) && a.toState === null);

describe('callback processing', () => {
  it('a result for a PENDING check is recorded and audited (actor provider)', async () => {
    await started();
    const cb = cbFor('RISK');
    expect(receive(cb)).toMatchObject({ duplicate: false, outcome: 'applied' });

    expect(row('RISK')[0]).toMatchObject({ status: 'PASSED', score: 12, completedAt: T0 + 5_000 });
    expect(row('RISK')[0]!.rawResponse).toEqual({ event_id: cb.event_id, result: { status: 'PASSED', score: 12 } });
    expect(nonRequestAudit()).toMatchObject([
      {
        actor: 'provider',
        event: 'VERIFICATION_RESULT',
        fromState: 'VERIFYING',
        toState: null,
        detail: { kind: 'RISK', request_id: cb.request_id, attempt: 1, status: 'PASSED', score: 12 },
      },
    ]);
    expect(events()).toMatchObject([{ processed: true, note: 'applied', isDuplicate: false }]);
  });

  it('a duplicate delivery changes nothing beyond one is_duplicate row', async () => {
    await started();
    const cb = cbFor('PAN', { result: { status: 'FAILED', reason: 'X' } });
    receive(cb);
    const before = { rows: rowsOf(db), audit: auditOf(db), app: appRow(db) };
    expect(receive({ ...cb })).toEqual({ duplicate: true, eventRowId: 2 });
    expect({ rows: rowsOf(db), audit: auditOf(db), app: appRow(db) }).toEqual(before);
    expect(events().map((e) => e.isDuplicate)).toEqual([false, true]);
  });

  it('a second, different event for an already completed check is ignored', async () => {
    await started();
    receive(cbFor('GST'));
    const audit = auditOf(db).length;
    expect(receive(cbFor('GST', { result: { status: 'FAILED' } }))).toMatchObject({ outcome: 'already_completed' });
    expect(row('GST')[0]!.status).toBe('PASSED');
    expect(auditOf(db)).toHaveLength(audit);
    expect(events().at(-1)).toMatchObject({ processed: true, note: 'already_completed' });
  });

  it('an unknown request_id is stored unprocessed; a request_id for another application is ignored', async () => {
    await started();
    expect(receive(cbFor('PAN', { request_id: 'nope' }))).toMatchObject({ outcome: 'unknown_request' });
    expect(receive(cbFor('PAN', { application_ref: 'app-2' }))).toMatchObject({ outcome: 'mismatch' });
    expect(receive(cbFor('PAN', { kind: 'GST' }))).toMatchObject({ outcome: 'mismatch' });
    expect(row('PAN')[0]!.status).toBe('PENDING');
    expect(events().map((e) => [e.processed, e.note])).toEqual([
      [false, 'unknown_request'],
      [true, 'mismatch'],
      [true, 'mismatch'],
    ]);
  });

  it('a callback that beats its request_id being stored is applied once the id is stored', async () => {
    verifyingApp(db);
    // A provider so fast its callback lands before the API has recorded the request_id.
    const racing: ProviderClient = {
      async request(kind, body) {
        const accepted = await fake.request(kind, body);
        receive({ event_id: `early-${kind}`, request_id: accepted.request_id, kind, result: { status: 'PASSED', score: 1 }, application_ref: 'app-1' });
        return accepted;
      },
    };
    await runStartVerifications({ ...env, now: T0 }, racing, 'app-1', ['PAN']);
    expect(row('PAN')[0]!.status).toBe('PASSED');
    expect(events()).toMatchObject([{ eventId: 'early-PAN', processed: true, note: 'applied (after request_id stored)' }]);
  });

  it('a late result for a TIMED_OUT check is recorded, audited LATE_CALLBACK and supersedes the pending retry', async () => {
    await started();
    const firstBank = cbFor('BANK');
    db.update(verifications).set({ status: 'TIMED_OUT' }).where(eq(verifications.kind, 'BANK')).run();
    await runStartVerifications({ ...env, now: T0 + 31_000 }, fake, 'app-1', ['BANK']);
    expect(row('BANK').map((r) => [r.attempt, r.status])).toEqual([
      [1, 'TIMED_OUT'],
      [2, 'PENDING'],
    ]);

    expect(receive(firstBank, T0 + 40_000)).toMatchObject({ outcome: 'late' });
    expect(row('BANK').map((r) => [r.attempt, r.status, r.superseded])).toEqual([
      [1, 'PASSED', false],
      [2, 'PENDING', true],
    ]);
    expect(currentVerification(db, appRow(db), 'BANK')!.attempt).toBe(1);
    expect(nonRequestAudit().at(-1)).toMatchObject({
      actor: 'provider',
      event: 'LATE_CALLBACK',
      detail: { kind: 'BANK', attempt: 1, status: 'PASSED', superseded_attempts: [2] },
    });

    // The retry's own callback then arrives: recorded but it does not count.
    expect(receive(cbFor('BANK'), T0 + 41_000)).toMatchObject({ outcome: 'stale' });
    expect(nonRequestAudit().at(-1)).toMatchObject({ event: 'STALE_CALLBACK', detail: { attempt: 2, ignored: 'superseded' } });
    expect(currentVerification(db, appRow(db), 'BANK')!.attempt).toBe(1);
  });

  it('a BANK result for an old bank_version is recorded but ignored', async () => {
    await started();
    const old = cbFor('BANK');
    db.update(applications).set({ bankVersion: 2 }).where(eq(applications.id, 'app-1')).run();
    expect(receive(old)).toMatchObject({ outcome: 'stale' });
    expect(row('BANK')[0]!.status).toBe('PASSED');
    expect(currentVerification(db, appRow(db), 'BANK')).toBeUndefined();
    expect(nonRequestAudit().at(-1)).toMatchObject({
      event: 'STALE_CALLBACK',
      detail: { ignored: 'old_bank_version', bank_version: 1, current_bank_version: 2 },
    });
  });

  it('a BANK callback echoing a different bank_version than requested is stale', async () => {
    await started();
    expect(receive(cbFor('BANK', { bank_version: 7 }))).toMatchObject({ outcome: 'stale' });
  });
});
