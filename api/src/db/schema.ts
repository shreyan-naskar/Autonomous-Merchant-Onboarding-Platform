import {
  APPLICATION_STATUSES,
  ACTORS,
  JOB_STATUSES,
  REVIEW_TASK_STATUSES,
  VALIDATION_STATUSES,
  VERIFICATION_KINDS,
  VERIFICATION_STATUSES,
} from '@app/shared';
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/*
 * Conventions: timestamps are epoch milliseconds (integer) from an injected
 * clock; booleans are 0/1 integers; JSON columns are text. Kept to plain SQL
 * types so a Postgres port is mechanical.
 */

export const applications = sqliteTable(
  'applications',
  {
    id: text().primaryKey(),
    // Only transition() may change this after insert.
    status: text({ enum: APPLICATION_STATUSES }).notNull(),
    merchantName: text('merchant_name').notNull(),
    pan: text(),
    gst: text(),
    bankAccount: text('bank_account'),
    ifsc: text(),
    bankVersion: integer('bank_version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    stateEnteredAt: integer('state_entered_at').notNull(),
    merchantId: text('merchant_id'),
  },
  (t) => [index('applications_status_idx').on(t.status)],
);

export const documents = sqliteTable(
  'documents',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id),
    type: text().notNull(),
    // File path for uploads; null for structured JSON documents.
    path: text(),
    // Structured document body (JSON) when submitted as JSON.
    payload: text({ mode: 'json' }),
    blurScore: real('blur_score'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('documents_app_idx').on(t.applicationId)],
);

export const extractedFields = sqliteTable(
  'extracted_fields',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id),
    documentId: integer('document_id').references(() => documents.id),
    field: text().notNull(),
    value: text(),
    confidence: real().notNull(),
    validationStatus: text('validation_status', { enum: VALIDATION_STATUSES }).notNull(),
  },
  (t) => [index('extracted_fields_app_idx').on(t.applicationId)],
);

export const verifications = sqliteTable(
  'verifications',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id),
    kind: text({ enum: VERIFICATION_KINDS }).notNull(),
    status: text({ enum: VERIFICATION_STATUSES }).notNull(),
    requestId: text('request_id'),
    attempt: integer().notNull().default(1),
    // applications.bank_version this check ran against (meaningful for BANK).
    bankVersion: integer('bank_version').notNull(),
    // Set when a newer check of the same kind replaces this one (e.g. bank change).
    superseded: integer({ mode: 'boolean' }).notNull().default(false),
    // Risk score 0-100 for RISK checks.
    score: integer(),
    requestedAt: integer('requested_at').notNull(),
    completedAt: integer('completed_at'),
    rawResponse: text('raw_response', { mode: 'json' }),
  },
  (t) => [
    index('verifications_app_kind_idx').on(t.applicationId, t.kind),
    uniqueIndex('verifications_request_id_uq').on(t.requestId),
  ],
);

export const callbackEvents = sqliteTable(
  'callback_events',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    eventId: text('event_id').notNull(),
    // Not a foreign key: a callback may name an unknown application and must still be recorded.
    applicationId: text('application_id'),
    kind: text(),
    payload: text({ mode: 'json' }).notNull(),
    receivedAt: integer('received_at').notNull(),
    processed: integer({ mode: 'boolean' }).notNull().default(false),
    isDuplicate: integer('is_duplicate', { mode: 'boolean' }).notNull().default(false),
    note: text(),
  },
  (t) => [
    // Idempotency: only one non-duplicate row per provider event_id.
    uniqueIndex('callback_events_event_id_uq')
      .on(t.eventId)
      .where(sql`${t.isDuplicate} = 0`),
    index('callback_events_app_idx').on(t.applicationId),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id),
    at: integer().notNull(),
    actor: text({ enum: ACTORS }).notNull(),
    // Null on creation (from) and for events that do not change status (to).
    fromState: text('from_state', { enum: APPLICATION_STATUSES }),
    toState: text('to_state', { enum: APPLICATION_STATUSES }),
    event: text().notNull(),
    detail: text({ mode: 'json' }),
  },
  (t) => [index('audit_log_app_idx').on(t.applicationId, t.id)],
);

export const reviewTasks = sqliteTable(
  'review_tasks',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id),
    reason: text().notNull(),
    status: text({ enum: REVIEW_TASK_STATUSES }).notNull().default('OPEN'),
    resolution: text(),
    note: text(),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('review_tasks_status_idx').on(t.status, t.applicationId)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    payload: text({ mode: 'json' }).notNull(),
    runAt: integer('run_at').notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    status: text({ enum: JOB_STATUSES }).notNull().default('queued'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('jobs_due_idx').on(t.status, t.runAt)],
);

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type AuditRow = typeof auditLog.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
