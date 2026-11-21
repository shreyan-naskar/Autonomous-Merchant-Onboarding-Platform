import {
  VERIFICATION_KINDS,
  type Actor,
  type ApplicationStatus,
  type AuditEvent,
  type ValidationStatus,
  type VerificationKind,
  type VerificationStatus,
} from './domain.js';
import type { ReviewResolution } from './review.js';

/* Plain language for every code the UI shows. Records are keyed by the shared enums, so a new state or event cannot ship without a label. */

export type Severity = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface Label {
  label: string;
  severity: Severity;
  description: string;
}

export const STATUS_LABELS: Record<ApplicationStatus, Label> = {
  SUBMITTED: { label: 'Submitted', severity: 'neutral', description: 'Received. Document extraction starts in a moment.' },
  EXTRACTING: { label: 'Reading documents', severity: 'info', description: 'Reading the documents and checking them against the form.' },
  NEEDS_INFO: { label: 'Needs information', severity: 'warning', description: 'Waiting for the merchant to supply missing information.' },
  VERIFYING: { label: 'Verifying', severity: 'info', description: 'PAN, GST, bank account and risk checks are with the providers.' },
  IN_REVIEW: { label: 'In review', severity: 'warning', description: 'A reviewer needs to decide on an exception.' },
  VERIFIED: { label: 'Verified', severity: 'success', description: 'All four checks passed. Approval is next.' },
  APPROVED: { label: 'Approved', severity: 'success', description: 'Approved. The merchant ID is being created.' },
  MERCHANT_CREATED: { label: 'Merchant created', severity: 'success', description: 'Onboarding complete: a merchant ID was issued.' },
  MERCHANT_CREATION_FAILED: {
    label: 'Merchant ID failed',
    severity: 'danger',
    description: 'Approved, but the merchant ID service kept failing. Retry it from the review queue.',
  },
  REJECTED: { label: 'Rejected', severity: 'danger', description: 'A reviewer rejected the application.' },
};

export const CHECK_LABELS: Record<VerificationKind, string> = {
  PAN: 'PAN',
  GST: 'GST',
  BANK: 'Bank account',
  RISK: 'Risk',
};

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, Label> = {
  PENDING: { label: 'Waiting for provider', severity: 'info', description: 'Requested; the provider has not answered yet.' },
  PASSED: { label: 'Passed', severity: 'success', description: 'The provider confirmed it.' },
  FAILED: { label: 'Failed', severity: 'danger', description: 'The provider rejected it.' },
  TIMED_OUT: { label: 'No answer', severity: 'warning', description: 'The provider did not answer in time.' },
};

export const VALIDATION_LABELS: Record<ValidationStatus, Label> = {
  ok: { label: 'OK', severity: 'success', description: 'Read clearly and consistent with the form.' },
  mismatch: { label: "Doesn't match", severity: 'danger', description: 'Differs from the form or another document.' },
  missing: { label: 'Missing', severity: 'warning', description: 'Not found on the document.' },
  low_confidence: { label: 'Unclear', severity: 'warning', description: 'Could not be read reliably, or the format is wrong.' },
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
  REQUEST_INFO: 'Request info',
  RETRY_VERIFICATION: 'Retry verification',
  RETRY_MERCHANT_CREATION: 'Retry merchant creation',
  DISMISS: 'Dismiss',
};

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
  VERIFICATION_REQUESTED: 'Check requested from provider',
  VERIFICATION_RESULT: 'Provider answered',
  VERIFICATION_TIMED_OUT: 'Provider did not answer in time',
  VERIFICATION_FAILED: 'A check failed',
  ALL_CHECKS_PASSED: 'All checks passed',
  LATE_CALLBACK: 'Late answer received and applied',
  STALE_CALLBACK: 'Answer for old bank details ignored',
  DUPLICATE_CALLBACK: 'Duplicate answer ignored',
  HIGH_RISK: 'High risk score',
  BANK_CHANGED: 'Bank details changed',
  BANK_REVERIFICATION_STARTED: 'Re-verifying the new bank details',
  AUTO_APPROVED: 'Approved automatically',
  OPERATOR_APPROVED: 'Approved by reviewer',
  OPERATOR_REJECTED: 'Rejected by reviewer',
  OPERATOR_REQUESTED_INFO: 'Reviewer requested information',
  OPERATOR_REVERIFY: 'Reviewer re-ran verification',
  MERCHANT_CREATED: 'Merchant ID issued',
  MERCHANT_CREATION_FAILED: 'Merchant ID creation failed',
  MERCHANT_CREATION_RETRY: 'Reviewer retried merchant ID creation',
  REVIEW_TASK_AUTO_RESOLVED: 'Review task resolved automatically',
  POSSIBLE_DUPLICATE: 'Possible duplicate detected',
  REVIEW_TASK_DISMISSED: 'Review task dismissed',
  JOB_FAILED: 'Background step failed, retrying',
  JOB_DEAD: 'Background step gave up',
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
    description: 'A value on a document differs from what the merchant entered (or from another document).',
  },
  LOW_CONFIDENCE: {
    label: 'Document values unclear',
    severity: 'warning',
    description: 'Some values could not be read reliably or have the wrong format. Check the documents.',
  },
  BLURRY_DOCUMENT: {
    label: 'Document image too blurry',
    severity: 'warning',
    description: 'An uploaded photo is too blurry to read. Read it yourself or ask for a sharper one.',
  },
  HIGH_RISK: {
    label: 'High risk score',
    severity: 'warning',
    description: 'All checks passed but the risk score is above the auto-approval limit, so a person must approve.',
  },
  BANK_CHANGED: {
    label: 'Bank details changed after verification',
    severity: 'info',
    description: 'The new account is being verified; approval waits for it.',
  },
  MERCHANT_CREATION_FAILED: {
    label: 'Merchant ID creation failed',
    severity: 'danger',
    description: 'Approved, but the merchant ID service failed after retries. Retry once it is back.',
  },
  JOB_DEAD: {
    label: 'Background step gave up',
    severity: 'danger',
    description: 'A background job ran out of retries. Requeue it from Dead letters.',
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
  PENDING: (c) => `${c} not answered yet`,
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
      label: `${check} check timed out`,
      severity: 'warning',
      description: `The ${check} provider did not answer, even after retries.`,
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
      description: 'A provider rejected a check. Decide whether to reject, request information or retry.',
      known: true,
    };
  }
  return { label: humanize(code), severity: 'neutral', description: '', known: false };
}
