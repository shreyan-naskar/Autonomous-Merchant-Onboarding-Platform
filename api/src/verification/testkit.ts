/* Test helpers for verification tests (imported only by *.test.ts). */
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { applications, auditLog, jobs, reviewTasks, verifications } from '../db/schema.js';
import { createApplication, type NewApplicationInput } from '../domain/applications.js';
import { transition } from '../domain/transition.js';
import { createLogger } from '../logger.js';

export const T0 = 1_700_000_000_000;

export const HAPPY_INPUT: NewApplicationInput = {
  merchantName: 'Lakshmi Textiles Pvt Ltd',
  pan: 'AABCL1234K',
  gst: '27AABCL1234K1Z5',
  bankAccount: '50100234567891',
  ifsc: 'HDFC0001234',
};

export function makeEnv() {
  const db = openDb(':memory:');
  const config = loadConfig({ DB_PATH: ':memory:', HMAC_SECRET: 'test-secret' });
  const logger = createLogger({ level: 'silent' });
  return { db, config, logger };
}

/** An application already moved to VERIFYING (as extraction would). */
export function verifyingApp(db: Db, id = 'app-1', input: NewApplicationInput = HAPPY_INPUT, now = T0) {
  createApplication(db, input, { now, id });
  transition(db, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now });
  return transition(db, id, 'VERIFYING', { actor: 'system', event: 'VERIFICATION_STARTED', now });
}

export const appRow = (db: Db, id = 'app-1') => db.select().from(applications).where(eq(applications.id, id)).get()!;
export const rowsOf = (db: Db, id = 'app-1') =>
  db.select().from(verifications).where(eq(verifications.applicationId, id)).orderBy(verifications.id).all();
export const auditOf = (db: Db, id = 'app-1') =>
  db.select().from(auditLog).where(eq(auditLog.applicationId, id)).orderBy(auditLog.id).all();
export const tasksOf = (db: Db, id = 'app-1') =>
  db.select().from(reviewTasks).where(eq(reviewTasks.applicationId, id)).orderBy(reviewTasks.id).all();
export const jobsOfType = (db: Db, type: string) => db.select().from(jobs).where(eq(jobs.type, type)).orderBy(jobs.id).all();
