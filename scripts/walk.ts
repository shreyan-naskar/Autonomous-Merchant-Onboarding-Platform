/**
 * Walk one application SUBMITTED -> MERCHANT_CREATED through transition()
 * and print its audit trail. Uses an in-memory DB unless WALK_DB is set.
 *
 *   npx tsx scripts/walk.ts
 */
import { REQUIRED_CHECKS, mask, type ApplicationStatus, type AuditEvent } from '@app/shared';
import { asc, eq } from 'drizzle-orm';
import { openDb } from '../api/src/db/client.js';
import { applications, auditLog, verifications } from '../api/src/db/schema.js';
import { createApplication } from '../api/src/domain/applications.js';
import { transition } from '../api/src/domain/transition.js';
import { GuardError } from '../api/src/errors.js';

const db = openDb(process.env.WALK_DB ?? ':memory:');
let clock = Date.now();
const tick = () => (clock += 1_000);

const app = createApplication(
  db,
  { merchantName: 'Acme Traders', pan: 'ABCDE1234F', gst: '27ABCDE1234F1Z5', bankAccount: '123456789012', ifsc: 'HDFC0001234' },
  { now: clock },
);
console.log(`Created ${app.id} (${app.merchantName}, PAN ${mask(app.pan)}, account ${mask(app.bankAccount)})\n`);

const step = (to: ApplicationStatus, event: AuditEvent, actor: 'system' | 'operator' = 'system', detail?: unknown) => {
  const row = transition(db, app.id, to, { actor, event, detail, now: tick() });
  console.log(`  -> ${row.status}`);
};

step('EXTRACTING', 'EXTRACTION_STARTED');
step('VERIFYING', 'VERIFICATION_STARTED', 'system', { checks: REQUIRED_CHECKS });
step('VERIFIED', 'ALL_CHECKS_PASSED');

// The approval guard blocks APPROVED until every required check has passed.
try {
  step('APPROVED', 'AUTO_APPROVED');
} catch (err) {
  if (!(err instanceof GuardError)) throw err;
  console.log(`  x APPROVED blocked by guard: ${err.message}`);
}

// Simulate the four provider results (Phase 4 does this via callbacks).
for (const kind of REQUIRED_CHECKS) {
  db.insert(verifications)
    .values({
      applicationId: app.id,
      kind,
      status: 'PASSED',
      bankVersion: app.bankVersion,
      score: kind === 'RISK' ? 22 : null,
      requestedAt: clock,
      completedAt: tick(),
    })
    .run();
}
console.log(`  (recorded PASSED for ${REQUIRED_CHECKS.join(', ')})`);

step('APPROVED', 'AUTO_APPROVED', 'system', { riskScore: 22 });
step('MERCHANT_CREATED', 'MERCHANT_CREATED', 'system', { merchantId: 'MID-WALK0001' });

const final = db.select().from(applications).where(eq(applications.id, app.id)).get()!;
const trail = db.select().from(auditLog).where(eq(auditLog.applicationId, app.id)).orderBy(asc(auditLog.id)).all();

console.log(`\nFinal status: ${final.status}\n\nAudit log (${trail.length} rows):`);
console.table(
  trail.map((a) => ({
    at: new Date(a.at).toISOString().slice(11, 19),
    actor: a.actor,
    from: a.fromState ?? '-',
    to: a.toState ?? '-',
    event: a.event,
    detail: a.detail == null ? '' : JSON.stringify(a.detail),
  })),
);
db.$client.close();
