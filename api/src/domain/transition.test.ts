import {
  ALLOWED_TRANSITIONS,
  APPLICATION_STATUSES,
  REQUIRED_CHECKS,
  type ApplicationStatus,
  type VerificationKind,
} from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/client.js';
import { applications, auditLog, verifications } from '../db/schema.js';
import { GuardError, IllegalTransitionError, NotFoundError } from '../errors.js';
import { createApplication } from './applications.js';
import { transition } from './transition.js';

const T0 = 1_700_000_000_000;
let db: Db;
let seq = 0;

beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.$client.close());

/** Test fixture: put an application directly into `status` (bypasses transition by design). */
function seedApp(status: ApplicationStatus, { bankVersion = 1 } = {}): string {
  const id = `app-${++seq}`;
  db.insert(applications)
    .values({
      id,
      status,
      merchantName: 'Acme Traders',
      pan: 'ABCDE1234F',
      bankAccount: '123456789012',
      ifsc: 'HDFC0001234',
      bankVersion,
      createdAt: T0,
      updatedAt: T0,
      stateEnteredAt: T0,
    })
    .run();
  return id;
}

function seedCheck(
  appId: string,
  kind: VerificationKind,
  status: 'PASSED' | 'FAILED' | 'PENDING' | 'TIMED_OUT' = 'PASSED',
  { bankVersion = 1, superseded = false } = {},
) {
  db.insert(verifications)
    .values({ applicationId: appId, kind, status, bankVersion, superseded, requestedAt: T0 })
    .run();
}

function seedAllPassed(appId: string, bankVersion = 1) {
  for (const kind of REQUIRED_CHECKS) seedCheck(appId, kind, 'PASSED', { bankVersion });
}

function snapshot(appId: string) {
  return {
    app: db.select().from(applications).where(eq(applications.id, appId)).get(),
    audit: db.select().from(auditLog).where(eq(auditLog.applicationId, appId)).all(),
  };
}

const LEGAL_EDGES = APPLICATION_STATUSES.flatMap((from) =>
  (ALLOWED_TRANSITIONS[from] as readonly ApplicationStatus[]).map((to) => [from, to] as const),
);
const ILLEGAL_EDGES = APPLICATION_STATUSES.flatMap((from) =>
  APPLICATION_STATUSES.filter((to) => !(ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to)).map(
    (to) => [from, to] as const,
  ),
);

describe('transition(): legal edges', () => {
  it('covers all 17 plan edges', () => {
    expect(LEGAL_EDGES).toHaveLength(17);
  });

  it.each(LEGAL_EDGES)('%s -> %s succeeds and writes one audit row', (from, to) => {
    const id = seedApp(from);
    if (to === 'APPROVED') seedAllPassed(id);
    const now = T0 + 5_000;

    const app = transition(db, id, to, {
      actor: 'system',
      event: 'VERIFICATION_RESULT',
      detail: { note: `${from}->${to}` },
      now,
    });

    expect(app.status).toBe(to);
    const { app: row, audit } = snapshot(id);
    expect(row).toMatchObject({ status: to, stateEnteredAt: now, updatedAt: now });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      applicationId: id,
      at: now,
      actor: 'system',
      fromState: from,
      toState: to,
      event: 'VERIFICATION_RESULT',
      detail: { note: `${from}->${to}` },
    });
  });
});

describe('transition(): illegal edges', () => {
  // Hand-picked edges that a buggy caller is most likely to attempt.
  const NAMED: [ApplicationStatus, ApplicationStatus][] = [
    ['SUBMITTED', 'APPROVED'],
    ['SUBMITTED', 'VERIFYING'],
    ['EXTRACTING', 'VERIFIED'],
    ['NEEDS_INFO', 'VERIFYING'],
    ['VERIFYING', 'APPROVED'],
    ['VERIFIED', 'MERCHANT_CREATED'],
    ['APPROVED', 'REJECTED'],
    ['REJECTED', 'IN_REVIEW'],
    ['MERCHANT_CREATED', 'APPROVED'],
    ['MERCHANT_CREATION_FAILED', 'MERCHANT_CREATED'],
    ['IN_REVIEW', 'IN_REVIEW'],
  ];

  it.each(NAMED)('%s -> %s throws IllegalTransitionError and changes nothing', (from, to) => {
    const id = seedApp(from);
    seedAllPassed(id); // guards must not be what stops it
    const before = snapshot(id);

    expect(() => transition(db, id, to, { actor: 'operator', event: 'OPERATOR_APPROVED', now: T0 + 1 })).toThrow(
      IllegalTransitionError,
    );
    expect(snapshot(id)).toEqual(before);
  });

  it(`rejects all ${ILLEGAL_EDGES.length} edges not in the map`, () => {
    for (const [from, to] of ILLEGAL_EDGES) {
      const id = seedApp(from);
      const before = snapshot(id);
      expect(() => transition(db, id, to, { actor: 'system', event: 'JOB_FAILED' }), `${from}->${to}`).toThrow(
        IllegalTransitionError,
      );
      expect(snapshot(id)).toEqual(before);
    }
  });

  it('carries from/to on the error for the HTTP layer', () => {
    const id = seedApp('SUBMITTED');
    try {
      transition(db, id, 'APPROVED', { actor: 'operator', event: 'OPERATOR_APPROVED' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).status).toBe(409);
      expect((err as IllegalTransitionError).details).toEqual({ from: 'SUBMITTED', to: 'APPROVED' });
    }
  });

  it('throws NotFoundError for an unknown application', () => {
    expect(() => transition(db, 'nope', 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED' })).toThrow(
      NotFoundError,
    );
  });
});

describe('transition(): APPROVED guard', () => {
  const approve = (id: string) =>
    transition(db, id, 'APPROVED', { actor: 'operator', event: 'OPERATOR_APPROVED', now: T0 + 1 });

  function expectBlocked(id: string, missing: string[]) {
    const before = snapshot(id);
    let caught: unknown;
    try {
      approve(id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuardError);
    expect((caught as GuardError).details).toMatchObject({ missing });
    expect(snapshot(id)).toEqual(before);
  }

  it.each(['VERIFIED', 'IN_REVIEW', 'MERCHANT_CREATION_FAILED'] as const)(
    'blocks %s -> APPROVED with no verifications',
    (from) => {
      expectBlocked(seedApp(from), ['PAN', 'GST', 'BANK', 'RISK']);
    },
  );

  it('blocks when one check failed', () => {
    const id = seedApp('IN_REVIEW');
    seedCheck(id, 'PAN');
    seedCheck(id, 'GST', 'FAILED');
    seedCheck(id, 'BANK');
    seedCheck(id, 'RISK');
    expectBlocked(id, ['GST']);
  });

  it('blocks when the latest attempt of a check is not PASSED', () => {
    const id = seedApp('VERIFIED');
    seedAllPassed(id);
    seedCheck(id, 'RISK', 'PENDING'); // newer re-run still pending
    expectBlocked(id, ['RISK']);
  });

  it('blocks when BANK passed only for an older bank_version', () => {
    const id = seedApp('IN_REVIEW', { bankVersion: 2 });
    seedAllPassed(id, 1);
    expectBlocked(id, ['BANK']);
  });

  it('blocks when the passed BANK check is superseded', () => {
    const id = seedApp('IN_REVIEW');
    for (const kind of ['PAN', 'GST', 'RISK'] as const) seedCheck(id, kind);
    seedCheck(id, 'BANK', 'PASSED', { superseded: true });
    expectBlocked(id, ['BANK']);
  });

  // Every way a single check can block approval, from both states that may approve.
  const BLOCKERS: [string, (id: string) => void, string][] = [
    ['RISK missing', (id) => ['PAN', 'GST', 'BANK'].forEach((k) => seedCheck(id, k as VerificationKind)), 'RISK'],
    ['GST failed', (id) => (seedAllPassed(id), seedCheck(id, 'GST', 'FAILED')), 'GST'],
    ['PAN pending', (id) => (seedAllPassed(id), seedCheck(id, 'PAN', 'PENDING')), 'PAN'],
    ['RISK timed out', (id) => (seedAllPassed(id), seedCheck(id, 'RISK', 'TIMED_OUT')), 'RISK'],
    [
      'BANK on an old bank_version',
      (id) => {
        db.update(applications).set({ bankVersion: 2 }).where(eq(applications.id, id)).run();
        seedAllPassed(id, 1);
      },
      'BANK',
    ],
    [
      'BANK superseded',
      (id) => {
        for (const kind of ['PAN', 'GST', 'RISK'] as const) seedCheck(id, kind);
        seedCheck(id, 'BANK', 'PASSED', { superseded: true });
      },
      'BANK',
    ],
  ];
  describe.each(['VERIFIED', 'IN_REVIEW'] as const)('from %s', (from) => {
    it.each(BLOCKERS)('blocks when %s', (_name, seed, kind) => {
      const id = seedApp(from);
      seed(id);
      expectBlocked(id, [kind]);
    });

    it('allows approval when all four passed for the current bank_version', () => {
      const id = seedApp(from);
      seedAllPassed(id);
      expect(approve(id).status).toBe('APPROVED');
    });
  });

  it('explains each blocking check in the error message', () => {
    const id = seedApp('VERIFIED', { bankVersion: 2 });
    seedAllPassed(id, 1);
    seedCheck(id, 'BANK', 'PENDING', { bankVersion: 2 });
    seedCheck(id, 'GST', 'FAILED');
    expect(() => approve(id)).toThrow(
      'Cannot approve: GST is failed; BANK is pending for bank version 2. All of PAN, GST, BANK, RISK must pass first.',
    );
  });

  it('allows approval once BANK passes for the current bank_version', () => {
    const id = seedApp('IN_REVIEW', { bankVersion: 2 });
    seedAllPassed(id, 1);
    seedCheck(id, 'BANK', 'PASSED', { bankVersion: 2 });
    expect(approve(id).status).toBe('APPROVED');
  });
});

describe('transition(): atomicity', () => {
  it('rolls back the status update when the audit insert fails', () => {
    const id = seedApp('SUBMITTED');
    const before = snapshot(id);
    db.$client.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END`);

    expect(() => transition(db, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: T0 + 9 })).toThrow(
      /audit insert failed/,
    );
    expect(snapshot(id)).toEqual(before);
    expect(db.$client.inTransaction).toBe(false);

    // And the app is still usable afterwards.
    db.$client.exec('DROP TRIGGER fail_audit');
    expect(transition(db, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED' }).status).toBe(
      'EXTRACTING',
    );
  });
});

describe('createApplication()', () => {
  it('inserts in SUBMITTED with a creation audit row from the merchant', () => {
    const app = createApplication(db, { merchantName: 'Acme Traders', pan: 'ABCDE1234F' }, { now: T0 });
    expect(app).toMatchObject({ status: 'SUBMITTED', bankVersion: 1, stateEnteredAt: T0, merchantId: null });
    const { audit } = snapshot(app.id);
    expect(audit).toEqual([
      expect.objectContaining({ actor: 'merchant', fromState: null, toState: 'SUBMITTED', event: 'APPLICATION_SUBMITTED' }),
    ]);
  });
});

describe('a full walk', () => {
  it('SUBMITTED to MERCHANT_CREATED leaves a contiguous audit trail', () => {
    const app = createApplication(db, { merchantName: 'Acme Traders' }, { now: T0 });
    const path: ApplicationStatus[] = ['EXTRACTING', 'VERIFYING', 'VERIFIED', 'APPROVED', 'MERCHANT_CREATED'];
    let t = T0;
    for (const to of path) {
      if (to === 'APPROVED') seedAllPassed(app.id);
      transition(db, app.id, to, { actor: 'system', event: 'VERIFICATION_RESULT', now: (t += 1000) });
    }
    const { audit } = snapshot(app.id);
    expect(audit.map((a) => a.toState)).toEqual(['SUBMITTED', ...path]);
    for (let i = 1; i < audit.length; i++) expect(audit[i].fromState).toBe(audit[i - 1].toState);
  });
});

describe('transition() inside a caller transaction', () => {
  it('commits with the caller', () => {
    const id = seedApp('SUBMITTED');
    db.transaction((tx) => {
      transition(tx, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: T0 + 1 });
    });
    expect(db.select().from(applications).where(eq(applications.id, id)).get()!.status).toBe('EXTRACTING');
  });

  it('rolls back status and audit row when the caller throws afterwards', () => {
    const id = seedApp('SUBMITTED');
    expect(() =>
      db.transaction((tx) => {
        transition(tx, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: T0 + 1 });
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(db.select().from(applications).where(eq(applications.id, id)).get()!.status).toBe('SUBMITTED');
    expect(db.select().from(auditLog).where(eq(auditLog.applicationId, id)).all()).toHaveLength(0);
  });
});
