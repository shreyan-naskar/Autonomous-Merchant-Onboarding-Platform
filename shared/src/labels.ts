import {
  VERIFICATION_KINDS,
  type Actor,
  type ApplicationStatus,
  type AuditEvent,
  type ValidationStatus,
  type VerificationKind,
  type VerificationStatus,
} from './domain.js';
import type { CheckProgress, ReviewResolution } from './review.js';

/* Plain language for every code the UI shows. Records are keyed by the shared enums, so a new state or event cannot ship without a label. */

export type Severity = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface Label {
  label: string;
  severity: Severity;
  description: string;
}

export const STATUS_LABELS: Record<ApplicationStatus, Label> = {
  SUBMITTED: { label: 'Submitted', severity: 'neutral', description: 'Received. Extraction pending.' },
  EXTRACTING: { label: 'Reading documents', severity: 'info', description: 'Documents being read and compared with the application.' },
  NEEDS_INFO: { label: 'Needs information', severity: 'warning', description: 'Awaiting information from the merchant.' },
  VERIFYING: { label: 'Verifying', severity: 'info', description: 'PAN, GST, bank account and risk verifications in progress.' },
  IN_REVIEW: { label: 'In review', severity: 'warning', description: 'Exception awaiting a reviewer decision.' },
  VERIFIED: { label: 'Verified', severity: 'success', description: 'All four verifications passed. Approval next.' },
  APPROVED: { label: 'Approved', severity: 'success', description: 'Approved. MID being issued.' },
  MERCHANT_CREATED: { label: 'Merchant created', severity: 'success', description: 'Onboarding complete. MID issued.' },
  MERCHANT_CREATION_FAILED: {
    label: 'Merchant ID failed',
    severity: 'danger',
    description: 'Approved. The MID service failed; retry available in the review queue.',
  },
  REJECTED: { label: 'Rejected', severity: 'danger', description: 'Rejected by a reviewer.' },
};

export const CHECK_LABELS: Record<VerificationKind, string> = {
  PAN: 'PAN',
  GST: 'GST',
  BANK: 'Bank account',
  RISK: 'Risk',
};

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, Label> = {
  PENDING: { label: 'Awaiting callback', severity: 'info', description: 'Requested; no callback yet.' },
  PASSED: { label: 'Passed', severity: 'success', description: 'Confirmed by the provider.' },
  FAILED: { label: 'Failed', severity: 'danger', description: 'Rejected by the provider.' },
  TIMED_OUT: { label: 'Timed out', severity: 'warning', description: 'No callback before the timeout.' },
};

export const VALIDATION_LABELS: Record<ValidationStatus, Label> = {
  ok: { label: 'OK', severity: 'success', description: 'Read clearly; consistent with the application.' },
  mismatch: { label: "Doesn't match", severity: 'danger', description: 'Differs from the application or another document.' },
  missing: { label: 'Missing', severity: 'warning', description: 'Not on the document.' },
  low_confidence: { label: 'Unclear', severity: 'warning', description: 'Low confidence or invalid format.' },
};

export const ACTOR_LABELS: Record<Actor, string> = {
  system: 'System',
  operator: 'Reviewer',
  provider: 'Provider',
  merchant: 'Merchant',
};

export const RESOLUTION_LABELS: Record<ReviewResolution, string> = {
  APPROVE: 'Approve',
  REJECT: 'Reject',
  REQUEST_INFO: 'Request information',
  RETRY_VERIFICATION: 'Run verification',
  RETRY_MERCHANT_CREATION: 'Retry merchant creation',
  DISMISS: 'Dismiss',
};

/** Button and dialog wording: re-running verification means something different before any verification has run. */
export function resolutionLabel(r: ReviewResolution, checks: CheckProgress): string {
  if (r !== 'RETRY_VERIFICATION') return RESOLUTION_LABELS[r];
  return checks === 'NOT_STARTED' ? 'Accept documents and verify' : checks === 'ALL_PASSED' ? 'Re-run all verifications' : 'Re-run verification';
}

export const EVENT_LABELS: Record<AuditEvent, string> = {
  APPLICATION_SUBMITTED: 'Application submitted',
  APPLICATION_UPDATED: 'Details updated',
  EXTRACTION_STARTED: 'Reading documents',
  INFO_REQUIRED: 'Information requested from the merchant',
  INFO_SUPPLIED: 'Merchant supplied information',
  DOC_CONFLICT: "Document doesn't match the form",
  BLURRY_DOCUMENT: 'Document image too blurry',
  LOW_CONFIDENCE: 'Document values unclear',
  VERIFICATION_STARTED: 'Verification started',
  VERIFICATION_REQUESTED: 'Verification requested',
  VERIFICATION_RESULT: 'Callback received',
  VERIFICATION_TIMED_OUT: 'Verification timed out',
  VERIFICATION_FAILED: 'Verification failed',
  ALL_CHECKS_PASSED: 'All verifications passed',
  LATE_CALLBACK: 'Late callback applied',
  STALE_CALLBACK: 'Callback for previous bank details ignored',
  DUPLICATE_CALLBACK: 'Duplicate callback ignored',
  HIGH_RISK: 'High risk score',
  BANK_CHANGED: 'Bank details changed',
  BANK_REVERIFICATION_STARTED: 'New bank details sent for verification',
  AUTO_APPROVED: 'Approved automatically',
  OPERATOR_APPROVED: 'Approved by reviewer',
  OPERATOR_REJECTED: 'Rejected by reviewer',
  OPERATOR_REQUESTED_INFO: 'Reviewer requested information',
  OPERATOR_REVERIFY: 'Reviewer re-ran verification',
  MERCHANT_CREATED: 'Merchant ID issued',
  MERCHANT_CREATION_FAILED: 'Merchant ID creation failed',
  MERCHANT_CREATION_RETRY: 'Reviewer retried Merchant ID creation',
  REVIEW_TASK_AUTO_RESOLVED: 'Review task resolved automatically',
  POSSIBLE_DUPLICATE: 'Possible duplicate detected',
  REVIEW_TASK_DISMISSED: 'Review task dismissed',
  JOB_FAILED: 'Background step failed · retry scheduled',
  JOB_DEAD: 'Background step exhausted retries',
  JOB_REQUEUED: 'Background step requeued',
};

// The API creates exactly these review reasons (api/src/labels.test.ts checks it).

export const STATIC_REVIEW_REASONS = [
  'DOC_CONFLICT',
  'LOW_CONFIDENCE',
  'BLURRY_DOCUMENT',
  'HIGH_RISK',
  'BANK_CHANGED',
  'MERCHANT_CREATION_FAILED',
  'JOB_DEAD',
  'POSSIBLE_DUPLICATE',
] as const;
export type StaticReviewReason = (typeof STATIC_REVIEW_REASONS)[number];

const STATIC_REASON_LABELS: Record<StaticReviewReason, Label> = {
  DOC_CONFLICT: {
    label: "Document doesn't match the form",
    severity: 'warning',
    description: 'A document value differs from the application or another document.',
  },
  LOW_CONFIDENCE: {
    label: 'Document values unclear',
    severity: 'warning',
    description: 'Values unreadable, low confidence or in an invalid format.',
  },
  BLURRY_DOCUMENT: {
    label: 'Document image too blurry',
    severity: 'warning',
    description: 'Uploaded image too blurry to read.',
  },
  HIGH_RISK: {
    label: 'High risk score',
    severity: 'warning',
    description: 'All verifications passed; risk score above the auto-approval limit.',
  },
  BANK_CHANGED: {
    label: 'Bank details changed after verification',
    severity: 'info',
    description: 'New bank account in verification; approval waits for it.',
  },
  MERCHANT_CREATION_FAILED: {
    label: 'Merchant ID creation failed',
    severity: 'danger',
    description: 'Approved; the MID service failed after retries.',
  },
  JOB_DEAD: {
    label: 'Background step failed',
    severity: 'danger',
    description: 'A background job exhausted its retries. Requeue from Dead letters.',
  },
  POSSIBLE_DUPLICATE: {
    label: 'Possible duplicate application',
    severity: 'warning',
    description: 'Shares a PAN, GSTIN or bank account with another application.',
  },
};

export const CHECK_RESULT_CODES = ['OK', 'FAILED', 'PENDING', 'TIMED_OUT'] as const;
type CheckResultCode = (typeof CHECK_RESULT_CODES)[number];
const CHECK_RESULT_WORDS: Record<CheckResultCode, (check: string) => string> = {
  OK: (c) => `${c} verified`,
  FAILED: (c) => `${c} verification failed`,
  PENDING: (c) => `${c} pending`,
  TIMED_OUT: (c) => `${c} timed out`,
};

export const timeoutReason = (kind: VerificationKind) => `${kind}_TIMEOUT`;

/** All 85 reasons evaluate() can produce. */
export function verificationFailureReasons(order: readonly VerificationKind[] = VERIFICATION_KINDS): string[] {
  const out: string[] = [];
  for (let last = 0; last < order.length; last++) {
    let prefixes: string[] = [''];
    for (let i = 0; i < last; i++) {
      prefixes = prefixes.flatMap((p) => CHECK_RESULT_CODES.map((r) => `${p}${order[i]}_${r}_`));
    }
    for (const p of prefixes) out.push(`${p}${order[last]}_FAILED`);
  }
  return out;
}

export function allReviewReasons(): string[] {
  return [...STATIC_REVIEW_REASONS, ...VERIFICATION_KINDS.map(timeoutReason), ...verificationFailureReasons()];
}

const KIND_RE = VERIFICATION_KINDS.join('|');
const RESULT_RE = CHECK_RESULT_CODES.join('|');
const VERIFICATION_REASON_RE = new RegExp(`^(?:(?:${KIND_RE})_(?:${RESULT_RE})_)*(?:${KIND_RE})_FAILED$`);
const PAIR_RE = new RegExp(`(${KIND_RE})_(${RESULT_RE})`, 'g');

export const humanize = (code: string) => {
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** `known` is false only for a code this module has never heard of (the label test fails on those). */
export function describeReason(code: string): Label & { known: boolean } {
  if ((STATIC_REVIEW_REASONS as readonly string[]).includes(code)) {
    return { ...STATIC_REASON_LABELS[code as StaticReviewReason], known: true };
  }
  const timeout = code.match(new RegExp(`^(${KIND_RE})_TIMEOUT$`));
  if (timeout) {
    const check = CHECK_LABELS[timeout[1] as VerificationKind];
    return {
      label: `${check} verification timed out`,
      severity: 'warning',
      description: `No ${check} callback after retries.`,
      known: true,
    };
  }
  if (VERIFICATION_REASON_RE.test(code)) {
    const parts = [...code.matchAll(PAIR_RE)].map(([, kind, result]) =>
      CHECK_RESULT_WORDS[result as CheckResultCode](CHECK_LABELS[kind as VerificationKind]),
    );
    return {
      label: parts.join(', '),
      severity: 'danger',
      description: 'A provider rejected a verification.',
      known: true,
    };
  }
  return { label: humanize(code), severity: 'neutral', description: '', known: false };
}
