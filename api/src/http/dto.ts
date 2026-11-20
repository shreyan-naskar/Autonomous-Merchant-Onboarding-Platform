import { basename } from 'node:path';
import {
  isSensitiveKey,
  mask,
  maskDeep,
  redactText,
  type ApplicationDetailDto,
  type ApplicationSummaryDto,
  type DocumentType,
} from '@app/shared';
import type { ApplicationDetailRows, ApplicationListRow } from '../domain/queries.js';

/*
 * The response-mapping layer. Every application-related response body is
 * built here, and this is the only place sensitive values are masked: routes
 * pass raw DB rows in and send whatever comes out. Free-form JSON (document
 * payloads, audit details) goes through maskDeep(); verification raw provider
 * responses are not exposed at all.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export function toSummaryDto(app: ApplicationListRow, now: number): ApplicationSummaryDto {
  return {
    id: app.id,
    status: app.status,
    merchant_name: app.merchantName,
    pan: mask(app.pan),
    gst: mask(app.gst),
    bank_account: mask(app.bankAccount),
    ifsc: app.ifsc,
    bank_version: app.bankVersion,
    merchant_id: app.merchantId,
    created_at: iso(app.createdAt),
    updated_at: iso(app.updatedAt),
    state_entered_at: iso(app.stateEnteredAt),
    time_in_state_ms: Math.max(0, now - app.stateEnteredAt),
    open_review_count: app.openReviewCount,
  };
}

export function toDetailDto(rows: ApplicationDetailRows, now: number): ApplicationDetailDto {
  return {
    ...toSummaryDto(rows.app, now),
    documents: rows.documents.map((d) => ({
      id: d.id,
      type: d.type as DocumentType,
      file_name: d.path ? basename(d.path) : null,
      payload: maskDeep(d.payload ?? null),
      blur_score: d.blurScore,
      created_at: iso(d.createdAt),
    })),
    extracted_fields: rows.extractedFields.map((f) => ({
      id: f.id,
      document_id: f.documentId,
      field: f.field,
      value: f.value === null ? null : isSensitiveKey(f.field) ? mask(f.value) : redactText(f.value),
      confidence: f.confidence,
      validation_status: f.validationStatus,
    })),
    verifications: rows.verifications.map((v) => ({
      id: v.id,
      kind: v.kind,
      status: v.status,
      attempt: v.attempt,
      bank_version: v.bankVersion,
      superseded: v.superseded,
      is_current: rows.currentVerificationIds.has(v.id),
      score: v.score,
      requested_at: iso(v.requestedAt),
      completed_at: isoOrNull(v.completedAt),
    })),
    review_tasks: rows.reviewTasks.map((t) => ({
      id: t.id,
      reason: t.reason,
      status: t.status,
      resolution: t.resolution,
      note: t.note === null ? null : redactText(t.note),
      resolution_note: t.resolutionNote === null ? null : redactText(t.resolutionNote),
      created_at: iso(t.createdAt),
      resolved_at: isoOrNull(t.resolvedAt),
    })),
    // Payloads are not exposed; only what the UI needs for late/duplicate markers.
    callbacks: rows.callbacks.map((c) => ({
      id: c.id,
      event_id: c.eventId,
      kind: c.kind,
      request_id: c.requestId,
      received_at: iso(c.receivedAt),
      is_duplicate: c.isDuplicate,
      processed: c.processed,
      note: c.note,
    })),
    audit_log: rows.auditLog.map((a) => ({
      id: a.id,
      at: iso(a.at),
      actor: a.actor,
      from_state: a.fromState,
      to_state: a.toState,
      event: a.event,
      detail: maskDeep(a.detail ?? null),
    })),
  };
}
