import { ApplicationDetailDtoSchema, checkProgress, ReviewQueueDtoSchema, resolutionsFor } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApprove } from '../approval/approve.js';
import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { applications, reviewTasks } from '../db/schema.js';
import { resolveReview } from '../review/resolve.js';
import { appRow, auditOf, HAPPY_INPUT, makeEnv, T0, tasksOf, verifiedApp } from '../verification/testkit.js';
import { submitApplication, type NewApplicationInput } from './applications.js';
import { findDuplicates, normalizeAccount, normalizeCode } from './duplicates.js';
import { sample } from '../testing.js';


let env: ReturnType<typeof makeEnv>;
let db: Db;
beforeEach(() => {
  env = makeEnv();
  db = env.db;
});
afterEach(() => db.$client.close());

const OTHER: NewApplicationInput = {
  merchantName: 'Ganesh Hardware Stores',
  pan: 'AACCG7777Q',
  gst: '29AACCG7777Q1Z3',
  bankAccount: '91200011122233',
  ifsc: 'SBIN0004567',
};
const submit = (id: string, input: NewApplicationInput, now = T0) => submitApplication(db, input, [], { id, now });

describe('normalization', () => {
  it('codes: uppercase without whitespace; accounts: digits only', () => {
    expect(normalizeCode(' aabcl 1234k ')).toBe('AABCL1234K');
    expect(normalizeAccount('5010-0234 5678 91')).toBe('50100234567891');
    expect(normalizeCode(null)).toBeNull();
    expect(normalizeAccount('')).toBeNull();
  });

  it('matches stored values that differ only in case / spacing', () => {
    // Intake normalizes, but rows written another way (or before) must still match.
    db.insert(applications)
      .values({
        id: 'legacy',
        merchantName: 'Legacy',
        pan: 'aabcl1234k',
        bankAccount: '5010 0234-5678 91',
        ifsc: 'hdfc0001234',
        status: 'SUBMITTED',
        stateEnteredAt: T0,
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
    const app = submit('new', HAPPY_INPUT, T0 + 1);
    expect(findDuplicates(db, app)).toEqual([{ applicationId: 'legacy', status: 'SUBMITTED', matchedOn: ['pan', 'bank'] }]);
  });
});

describe('duplicate detection at submit', () => {
  it('same PAN, GSTIN and bank: one POSSIBLE_DUPLICATE task on the new app linking the earlier one', () => {
    submit('first', HAPPY_INPUT);
    submit('second', { ...HAPPY_INPUT, merchantName: 'Lakshmi Textiles (again)' }, T0 + 1);

    expect(tasksOf(db, 'first')).toEqual([]);
    expect(tasksOf(db, 'second')).toMatchObject([
      {
        reason: 'POSSIBLE_DUPLICATE',
        status: 'OPEN',
        relatedApplicationId: 'first',
        note: 'Same PAN, GSTIN, bank account + IFSC as application first',
      },
    ]);
    // Both sides audited, values never written.
    const detail = { related_application_id: 'first', matched_on: ['pan', 'gst', 'bank'] };
    expect(auditOf(db, 'second').at(-1)).toMatchObject({ event: 'POSSIBLE_DUPLICATE', toState: null, fromState: 'SUBMITTED', detail });
    expect(auditOf(db, 'first').at(-1)).toMatchObject({
      event: 'POSSIBLE_DUPLICATE',
      toState: null,
      detail: { related_application_id: 'second', matched_on: ['pan', 'gst', 'bank'] },
    });
    expect(JSON.stringify(auditOf(db, 'second'))).not.toContain(HAPPY_INPUT.pan);
  });

  it.each([
    ['PAN only', { pan: HAPPY_INPUT.pan }, ['pan']],
    ['GSTIN only', { gst: HAPPY_INPUT.gst }, ['gst']],
    ['account + IFSC', { bankAccount: HAPPY_INPUT.bankAccount, ifsc: HAPPY_INPUT.ifsc }, ['bank']],
  ] as const)('matches on %s', (_label, patch, matchedOn) => {
    submit('first', HAPPY_INPUT);
    const app = submit('second', { ...OTHER, ...patch }, T0 + 1);
    expect(findDuplicates(db, app)).toEqual([{ applicationId: 'first', status: 'SUBMITTED', matchedOn: [...matchedOn] }]);
    expect(tasksOf(db, 'second')).toHaveLength(1);
  });

  it('the same account number at a different bank (IFSC) is not a duplicate', () => {
    submit('first', HAPPY_INPUT);
    submit('second', { ...OTHER, bankAccount: HAPPY_INPUT.bankAccount }, T0 + 1);
    expect(tasksOf(db, 'second')).toEqual([]);
  });

  it('one task per earlier match, including rejected applications', () => {
    submit('a', HAPPY_INPUT);
    submit('b', { ...OTHER, pan: HAPPY_INPUT.pan }, T0 + 1);
    db.update(applications).set({ status: 'REJECTED' }).where(eq(applications.id, 'a')).run();
    submit('c', { ...OTHER, pan: HAPPY_INPUT.pan, merchantName: 'Third' }, T0 + 2);
    expect(tasksOf(db, 'c').map((t) => t.relatedApplicationId)).toEqual(['a', 'b']);
  });

  it('the bundled sample files never match each other', async () => {
    const app = createApp({ ...env, now: () => T0 });
    for (const f of ['happy.json', 'gst-fail.json', 'conflict.json', 'missing.json', 'high-risk.json', 'ocr-pan.json', 'low-confidence.json']) {
      await request(app).post('/applications').send(sample(f)).expect(201);
    }
    for (const a of db.select().from(applications).all()) expect(tasksOf(db, a.id)).toEqual([]);
  });

  it('does not block submission: 201, SUBMITTED, extract queued; the DTO links the other app', async () => {
    const app = createApp({ ...env, now: () => T0 });
    const first = await request(app).post('/applications').send(sample('happy.json')).expect(201);
    const second = await request(app).post('/applications').send(sample('happy.json')).expect(201);
    const dto = ApplicationDetailDtoSchema.parse(second.body);
    expect(dto.status).toBe('SUBMITTED');
    expect(dto.review_tasks).toMatchObject([{ reason: 'POSSIBLE_DUPLICATE', related_application_id: first.body.id }]);
    expect(dto.open_review_count).toBe(1);

    const queue = ReviewQueueDtoSchema.parse((await request(app).get('/review-tasks?status=OPEN')).body);
    expect(queue.items).toMatchObject([{ application_id: second.body.id, related_application_id: first.body.id }]);
  });
});

/** Open a POSSIBLE_DUPLICATE task on `appId` (as submit would have). */
function linkDuplicate(appId: string, relatedId = 'first') {
  return db
    .insert(reviewTasks)
    .values({ applicationId: appId, reason: 'POSSIBLE_DUPLICATE', status: 'OPEN', relatedApplicationId: relatedId, note: 'dup', createdAt: T0 })
    .returning()
    .get();
}

describe('approval while a duplicate task is open', () => {
  it('holds auto-approval: VERIFIED -> IN_REVIEW (POSSIBLE_DUPLICATE), no extra task', () => {
    verifiedApp(db, 'app-1', { riskScore: 20 });
    const task = linkDuplicate('app-1');
    expect(runApprove({ ...env, now: T0 + 10 }, 'app-1')).toBe('possible_duplicate');
    expect(appRow(db).status).toBe('IN_REVIEW');
    expect(auditOf(db).at(-1)).toMatchObject({
      fromState: 'VERIFIED',
      toState: 'IN_REVIEW',
      event: 'POSSIBLE_DUPLICATE',
      detail: { reason: 'POSSIBLE_DUPLICATE', task_ids: [task.id], related_application_ids: ['first'] },
    });
    expect(tasksOf(db).map((t) => t.reason)).toEqual(['POSSIBLE_DUPLICATE']);
  });

  it('high risk as well: HIGH_RISK task added next to the duplicate task', () => {
    verifiedApp(db, 'app-1', { riskScore: 85 });
    const task = linkDuplicate('app-1');
    expect(runApprove({ ...env, now: T0 + 10 }, 'app-1')).toBe('high_risk');
    expect(auditOf(db).at(-1)).toMatchObject({ event: 'HIGH_RISK', detail: { open_duplicate_task_ids: [task.id] } });
    expect(tasksOf(db).map((t) => t.reason)).toEqual(['POSSIBLE_DUPLICATE', 'HIGH_RISK']);
  });

  it('operator APPROVE on the duplicate task from IN_REVIEW approves', () => {
    verifiedApp(db, 'app-1', { riskScore: 20 });
    const task = linkDuplicate('app-1');
    runApprove({ ...env, now: T0 + 10 }, 'app-1');
    const app = resolveReview(db, env.config, 'app-1', { taskId: task.id, resolution: 'APPROVE', note: 'Same owner, second outlet' }, T0 + 20);
    expect(app.status).toBe('APPROVED');
    expect(tasksOf(db)[0]).toMatchObject({ status: 'RESOLVED', resolution: 'APPROVE' });
  });

  it('a dismissed duplicate task no longer holds approval', () => {
    verifiedApp(db, 'app-1', { riskScore: 20 });
    const task = linkDuplicate('app-1');
    resolveReview(db, env.config, 'app-1', { taskId: task.id, resolution: 'DISMISS', note: 'Different business' }, T0 + 5);
    expect(runApprove({ ...env, now: T0 + 10 }, 'app-1')).toBe('approved');
  });
});

describe('DISMISS', () => {
  it('closes the task without a transition and audits it (actor operator)', () => {
    submit('first', HAPPY_INPUT);
    submit('second', HAPPY_INPUT, T0 + 1);
    const task = tasksOf(db, 'second')[0]!;
    const app = resolveReview(db, env.config, 'second', { taskId: task.id, resolution: 'DISMISS', note: 'Checked: re-submission' }, T0 + 2);
    expect(app.status).toBe('SUBMITTED');
    expect(tasksOf(db, 'second')[0]).toMatchObject({ status: 'RESOLVED', resolution: 'DISMISS', resolutionNote: 'Checked: re-submission' });
    expect(auditOf(db, 'second').at(-1)).toMatchObject({
      actor: 'operator',
      fromState: 'SUBMITTED',
      toState: null,
      event: 'REVIEW_TASK_DISMISSED',
      detail: { task_id: task.id, task_reason: 'POSSIBLE_DUPLICATE', resolution: 'DISMISS' },
    });
  });

  it('409 for a task that is not informational', () => {
    verifiedApp(db, 'app-1', { riskScore: 85 });
    runApprove({ ...env, now: T0 + 10 }, 'app-1');
    const task = tasksOf(db)[0]!;
    expect(() => resolveReview(db, env.config, 'app-1', { taskId: task.id, resolution: 'DISMISS', note: 'go away' }, T0 + 20)).toThrow(
      expect.objectContaining({ status: 409, code: 'NOT_DISMISSIBLE' }),
    );
    expect(tasksOf(db)[0]!.status).toBe('OPEN');
  });

  it('409 while the application is IN_REVIEW (a decision is needed)', () => {
    verifiedApp(db, 'app-1', { riskScore: 20 });
    const task = linkDuplicate('app-1');
    runApprove({ ...env, now: T0 + 10 }, 'app-1');
    expect(() => resolveReview(db, env.config, 'app-1', { taskId: task.id, resolution: 'DISMISS', note: 'not a dup' }, T0 + 20)).toThrow(
      expect.objectContaining({ status: 409, code: 'ILLEGAL_TRANSITION' }),
    );
  });
});

describe('resolutionsFor', () => {
  it('DISMISS only for informational tasks, never while IN_REVIEW', () => {
    expect(resolutionsFor('VERIFYING', 'POSSIBLE_DUPLICATE', 'INCOMPLETE')).toEqual(['DISMISS']);
    expect(resolutionsFor('VERIFYING', 'BANK_CHANGED', 'INCOMPLETE')).toEqual([]);
    expect(resolutionsFor('IN_REVIEW', 'POSSIBLE_DUPLICATE', 'ALL_PASSED')).toEqual(['APPROVE', 'REJECT', 'REQUEST_INFO', 'RETRY_VERIFICATION']);
    expect(resolutionsFor('IN_REVIEW', 'DOC_CONFLICT', 'NOT_STARTED')).not.toContain('DISMISS');
  });

  it('APPROVE is offered only once every check has passed (the approval guard refuses it otherwise)', () => {
    expect(resolutionsFor('IN_REVIEW', 'HIGH_RISK', 'ALL_PASSED')).toContain('APPROVE');
    expect(resolutionsFor('IN_REVIEW', 'PAN_OK_GST_FAILED', 'INCOMPLETE')).toEqual(['REJECT', 'REQUEST_INFO', 'RETRY_VERIFICATION']);
    expect(resolutionsFor('VERIFIED', 'POSSIBLE_DUPLICATE', 'ALL_PASSED')).toEqual(['APPROVE', 'DISMISS']);
  });

  it('a document-stage review (no check has run) leads with accepting the documents', () => {
    expect(resolutionsFor('IN_REVIEW', 'LOW_CONFIDENCE', 'NOT_STARTED')).toEqual(['RETRY_VERIFICATION', 'REJECT', 'REQUEST_INFO']);
  });

  it('checkProgress: nothing requested, something not passed, all passed', () => {
    expect(checkProgress([undefined, undefined, undefined, undefined])).toBe('NOT_STARTED');
    expect(checkProgress(['PASSED', 'FAILED', undefined, undefined])).toBe('INCOMPLETE');
    expect(checkProgress(['PASSED', 'PASSED', 'PENDING', 'PASSED'])).toBe('INCOMPLETE');
    expect(checkProgress(['PASSED', 'PASSED', 'PASSED', 'PASSED'])).toBe('ALL_PASSED');
  });
});
