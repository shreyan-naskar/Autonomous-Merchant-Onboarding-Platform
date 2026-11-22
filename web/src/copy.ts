/*
 * Every piece of web wording, in one place. copy.test.ts enforces
 * the banned words in the copy standard. Domain labels for statuses,
 * events and review reasons live in shared/src/labels.ts.
 */

import { plural } from './lib/format.ts'

export const PRODUCT = {
  name: 'Onboarding Console',
  tagline: 'Merchant operations',
} as const

export const NAV = {
  operations: 'Operations',
  merchant: 'Merchant',
  admin: 'Admin',
  applications: 'Applications',
  reviewQueue: 'Review queue',
  submit: 'Submit application',
  scenarios: 'Scenarios',
  deadLetters: 'Dead letters',
  demo: 'Demo controls',
  mainNavigation: 'Main navigation',
  skip: 'Skip to content',
  open: 'Open navigation',
  close: 'Close navigation',
  expand: 'Expand sidebar',
  collapse: 'Collapse sidebar',
  collapseShort: 'Collapse',
  openCount: (n: number) => `${n} open`,
} as const

export const SEARCH = {
  label: 'Search applications by merchant name or ID',
  placeholder: 'Search merchant or ID…',
  openId: 'Press Enter to open this ID',
  none: 'No matching applications',
} as const

export const HEALTH = {
  up: 'API online',
  down: 'API unreachable',
  checking: 'Checking API…',
} as const

export const COMMON = {
  cancel: 'Cancel',
  retry: 'Retry',
  copy: 'Copy',
  copied: 'Copied',
  loading: 'Loading',
  none: '—',
  goHome: 'Go to applications',
  goBack: 'Go back',
  noteLabel: 'Note for the audit trail',
  noteCount: (n: number, min: number) => (n < min ? `${n} / ${min} characters minimum` : plural(n, 'character')),
  sizeLimit: 'up to 5 MB',
  dismiss: 'Dismiss',
  on: 'On',
  off: 'Off',
  close: 'Close',
  breadcrumb: 'Breadcrumb',
  pan: 'PAN',
  gstin: 'GSTIN',
} as const

export const ERRORS = {
  generic: 'Unable to complete the request',
  pageTitle: 'Unable to load this page.',
  pageText: 'An unexpected error stopped this page.',
  technical: 'Technical details (development only)',
  serverTitle: 'Server error',
  serverText: 'The server returned an error.',
  serverDocTitle: 'Server error',
  waitingTitle: 'Service unavailable. Reconnecting…',
  waitingText: 'This page loads when the server responds.',
  offline: 'Service unavailable. Reconnecting…',
  offlineDetail: 'Showing the last loaded data.',
  networkTitle: 'Service unavailable',
  networkText: 'Reconnecting…',
  serverMessage: 'The server returned an error.',
  notFound: 'Not found',
  validationTitle: 'Invalid input',
  conflictTitle: 'Action unavailable',
  rejectedTitle: 'Request not accepted',
  approveTitle: 'Approval unavailable',
  approveRule: 'All four verifications (PAN, GST, bank account, risk) must pass.',
  checkState: { PENDING: 'pending', FAILED: 'failed', TIMED_OUT: 'timed out', MISSING: 'not started' } as Record<string, string>,
  checkName: { PAN: 'PAN', GST: 'GST', BANK: 'bank', RISK: 'risk' } as Record<string, string>,
  /** "Approval unavailable: bank verification pending." */
  approveBlocked: (parts: string[]) => `Approval unavailable: ${parts.join(', ')}.`,
  newBank: 'new bank details',
} as const

export const NOT_FOUND = {
  title: 'Page not found',
  text: 'No page at this address.',
  application: 'Application not found',
  applicationText: (id: string) => `No application with ID ${id}.`,
} as const

export const CHAOS_BANNER = {
  label: 'Demo failure mode on:',
  link: 'Demo controls',
  off: 'Turn all off',
} as const

export const APPLICATIONS = {
  title: 'Applications',
  subtitle: 'All merchant applications and their onboarding status.',
  filterLabel: 'Filter by merchant name or ID',
  filterPlaceholder: 'Filter by merchant or ID',
  attentionOnly: 'Needs attention only',
  statusFilter: 'Filter by status',
  all: 'All',
  loading: 'Loading applications',
  empty: 'No applications',
  emptyText: 'Submitted applications appear here.',
  noMatch: 'No matching applications',
  noMatchText: 'No application matches these filters.',
  clearFilters: 'Clear filters',
  caption: (n: number) => `Applications, ${n} shown`,
  columns: {
    merchant: 'Merchant',
    status: 'Status',
    timeInState: 'Time in state',
    openReviews: 'Open review tasks',
    mid: 'MID',
    submitted: 'Submitted',
  },
  openTasks: 'open review tasks',
} as const

export const METRICS = {
  region: 'Operational metrics',
  loading: 'Loading metrics',
  applications: 'Applications',
  onboarded: (n: string) => `${n} onboarded`,
  exceptionRate: 'Exception rate',
  exceptions: (n: number) => plural(n, 'exception'),
  attention: 'Needs attention',
  attentionHint: 'Needs information · In review · Merchant ID failed',
  avgVerifying: 'Avg verification time',
  avgVerifyingHint: 'Request to last callback',
  byStatus: 'Applications by status',
  timeInState: 'Average time in state',
} as const

export const DETAIL = {
  loading: 'Loading application',
  inState: 'In this state',
  submitted: 'Submitted',
  mid: 'Merchant ID (MID)',
  copyMid: 'Copy MID',
  applicationId: 'Application ID',
  copyId: 'Copy application ID',
  sections: 'Application sections',
  tabs: { overview: 'Overview', timeline: 'Timeline', documents: 'Documents', bank: 'Bank details' },
  reviewTasks: 'Review tasks',
  verification: 'Verification',
  verificationSub: 'PAN, GST, bank account and risk',
  extracted: 'Extracted fields',
  extractedSub: 'Values read from the documents, compared with the application',
  audit: 'Audit trail',
  auditSub: 'Every event, actor and time',
  provideInfo: 'Provide missing information',
  review: (n: number) => (n > 1 ? `Review ${plural(n, 'task')}` : 'Review task'),
  retryMerchant: 'Retry merchant creation',
  waiting: {
    SUBMITTED: 'Starting…',
    EXTRACTING: 'Reading documents…',
    VERIFYING: 'Awaiting callbacks…',
    VERIFIED: 'Approving…',
    APPROVED: 'Creating MID…',
  } as Record<string, string>,
  inProgress: 'In progress…',
  statusChanged: (label: string) => `Status: ${label}`,
} as const

export const STEPPER = {
  label: 'Onboarding progress',
  steps: {
    SUBMITTED: 'Submitted',
    EXTRACTING: 'Extraction',
    VERIFYING: 'Verification',
    VERIFIED: 'Verified',
    APPROVED: 'Approved',
    MERCHANT_CREATED: 'Merchant created',
  } as Record<string, string>,
  done: '(done)',
  current: '(current)',
  todo: '(not yet)',
} as const

export const VERIFICATION = {
  rechecking: 'Re-checking',
  notStarted: 'Not started',
  attempt: 'Attempt',
  bankVersion: 'Bank details version',
  riskScore: 'Risk score',
  high: 'high',
  requested: 'Requested',
  answered: 'Callback',
  pending: {
    resent: 'Sent to the provider again.',
    review: 'Runs after review.',
    info: 'Runs after the merchant provides information.',
    rejected: 'Not run: application rejected.',
    default: 'Runs after extraction.',
  },
  late: (n: number) => `Late ×${n}`,
  lateTip: 'Callback arrived after the timeout; recorded and applied.',
  duplicate: (n: number) => `Duplicate ignored ×${n}`,
  duplicateTip: 'Repeated callback; ignored.',
  stale: (n: number) => `Stale ×${n}`,
  staleTip: 'Callback for previous bank details; ignored.',
  attempts: (n: number) => plural(n, 'attempt'),
  bankV: (v: number) => ` (bank details v${v})`,
} as const

export const EXTRACTED = {
  empty: 'No extracted fields yet.',
  field: 'Field',
  value: 'Value',
  confidence: 'Confidence',
  check: 'Check',
  confidenceLabel: (pct: number) => `Confidence ${pct}%`,
} as const

export const TIMELINE = {
  label: 'Audit trail',
  details: 'Details',
} as const

export const DOCUMENTS = {
  empty: 'No documents',
  emptyText: 'Submitted without documents.',
  uploaded: (name: string) => `File · ${name}`,
  structured: 'Structured data',
  added: (when: string) => `Added ${when}`,
  sharpness: (score: number, blurry: boolean) => `Sharpness ${score} · ${blurry ? 'blurry' : 'sharp'}`,
  sharpnessTip: 'Laplacian variance; below 30 is too blurry to read.',
  view: 'View file',
} as const

export const VIEWER = {
  uploaded: (kind: string) => `Uploaded by the merchant · ${kind}`,
  pdf: 'PDF',
  image: (ext: string) => `${ext} image`,
  openTab: 'Open in new tab',
  close: 'Close',
  preview: (label: string) => `${label}, uploaded by the merchant`,
  noPreview: 'No preview for this file type.',
  read: 'Extracted values',
  nothing: 'No extracted values yet.',
  notRead: 'not read',
  confidence: (pct: number) => `${pct}% confidence`,
  footnote: 'Values masked. File shown as uploaded; not cached.',
} as const

export const BANK = {
  account: 'Account',
  ifsc: 'IFSC',
  version: 'Version',
  checks: 'Bank account verifications',
  notRequested: 'Not requested.',
  row: (v: number, attempt: number) => `Bank details v${v} · attempt ${attempt}`,
  replaced: 'replaced',
  change: 'Change bank details (merchant)',
  changeText: 'A change after verification sends the new account for verification; approval waits for it.',
  newAccount: 'New account number',
  newIfsc: 'New IFSC',
  locked: 'Bank details locked in this state.',
  submit: 'Change bank details',
  updated: 'Bank details updated',
  updatedText: (status: string) => `Status: ${status} · new account sent for verification`,
} as const

export const REVIEW = {
  title: 'Review queue',
  subtitle: 'Open review tasks, oldest first.',
  loading: 'Loading review tasks',
  empty: 'No open review tasks',
  filter: 'Filter by severity',
  filters: { all: 'All', danger: 'Failures', warning: 'Needs judgement', info: 'Informational' },
  reason: 'Reason',
  checksNow: 'Verification now',
  checksNowLabel: 'Current verification status',
  atEscalation: 'At time of escalation',
  notStarted: 'not started',
  notePlaceholder: 'Reason for this decision',
  noAction: 'No action available in this state.',
  opened: (when: string) => `Opened ${when}`,
  duplicateOf: 'Possible duplicate of',
  uploads: 'Uploads:',
  requeue: 'Requeue in Dead letters',
  resolved: 'Resolved:',
  ariaTask: (reason: string, merchant: string) => `${reason} for ${merchant}`,
  effect: {
    APPROVE: 'The application is approved and a MID is issued.',
    REJECT: 'The application is rejected. This is final.',
    REQUEST_INFO: 'The application returns to the merchant for information or documents.',
    RETRY_NOT_STARTED: 'The documents are accepted as read and all four verifications run.',
    RETRY_ALL_PASSED: 'All four verifications run again.',
    RETRY_SOME: 'Verifications that have not passed run again.',
    RETRY_MERCHANT_CREATION: 'MID creation runs again.',
    DISMISS: 'The task closes. The application is unchanged.',
  },
  done: {
    APPROVE: 'Application approved',
    REJECT: 'Application rejected',
    REQUEST_INFO: 'Information requested',
    RETRY_NOT_STARTED: 'Documents accepted · verification started',
    RETRY: 'Verification restarted',
    RETRY_MERCHANT_CREATION: 'MID creation restarted',
    DISMISS: 'Review task dismissed',
  },
  approveNotStarted: 'Approval unavailable: verification not started.',
  approveIncomplete: 'Approval unavailable: verification incomplete.',
} as const

export const MISSING_INFO = {
  title: 'Information required from the merchant',
  byReviewer: 'Information requested by a reviewer.',
  now: (v: string) => `Current: ${v}`,
  structured: 'structured data',
  everything: 'Fields and documents',
  other: 'Other changes',
  json: 'Documents as JSON (advanced)',
  jsonError: 'Documents must be a JSON array of {type, payload}',
  send: 'Send information',
  sent: 'Information sent',
  sentText: 'Documents queued for extraction.',
} as const

export const FILE_DROP = {
  choose: 'Choose a file',
  drag: 'or drag it here',
  onlyFormats: (formats: string) => `${formats} only`,
  tooLarge: '5 MB maximum',
  preview: (name: string) => `Preview of ${name}`,
  remove: (name: string) => `Remove ${name}`,
} as const

export const SUBMIT = {
  title: 'Submit application',
  subtitle: 'New merchant application with documents.',
  steps: ['Business details', 'Documents', 'Review and submit'] as const,
  stepsLabel: 'Steps',
  scenario: (caption: string) => `Scenario: ${caption}`,
  scenarioSample: (file: string) => `Prefilled from ${file}`,
  change: 'Change',
  business: 'Business details',
  businessSub: 'Declared by the merchant. Documents are checked against these values.',
  documents: 'Documents',
  documentsSub: 'PAN card, GST certificate and bank proof. PDF (including scans) or image.',
  structuredFrom: 'Structured data from the scenario',
  removeStructured: (label: string) => `Remove structured ${label}`,
  advanced: 'Advanced: structured documents as JSON',
  advancedLabel: 'Documents (JSON array of {type, payload})',
  advancedError: 'Advanced documents must be a JSON array of {type, payload}',
  review: 'Review and submit',
  notGiven: 'not given',
  missingDoc: 'missing · requested from the merchant',
  fileSource: (name: string) => `File: ${name}`,
  structuredSource: 'Structured data',
  docRejected: 'Document rejected',
  back: 'Back',
  continue: 'Continue',
  send: 'Submit application',
  doneTitle: 'Submitted for verification',
  doneText: (name: string) => `Application received for ${name}. Extraction and verification are in progress.`,
  doneTextPrefix: 'Application received for',
  doneTextSuffix: 'Extraction and verification are in progress.',
  reference: 'Reference',
  copyReference: 'Copy reference',
  findIt: 'Listed under Applications.',
  another: 'Submit another application',
  toList: 'Go to applications',
  fields: {
    merchant_name: { label: 'Business name', placeholder: 'Lakshmi Textiles Pvt Ltd' },
    pan: { label: 'PAN', placeholder: 'AABCL1234K', hint: '5 letters, 4 digits, 1 letter' },
    gst: { label: 'GSTIN', placeholder: '27AABCL1234K1Z5', hint: '15 characters, contains the PAN' },
    bank_account: { label: 'Bank account number', placeholder: '50100234567891', hint: '9 to 18 digits' },
    ifsc: { label: 'IFSC', placeholder: 'HDFC0001234', hint: '4 letters, 0, then 6 letters or digits' },
  },
  invalid: {
    merchant_name: 'Business name required (at least 2 characters)',
    pan: 'PAN format: 5 letters, 4 digits, 1 letter',
    gst: 'GSTIN format: 15 characters',
    bank_account: 'Account number: 9 to 18 digits',
    ifsc: 'IFSC format: 4 letters, 0, then 6 letters or digits',
  },
} as const

export const SCENARIOS = {
  title: 'Scenarios',
  subtitle: 'Failure cases from the problem statement. Start prefills an application and sets the demo switches.',
  setup: 'Setup',
  outcome: 'Expected outcome',
  sample: 'Sample',
  start: 'Start',
  startLabel: (caption: string) => `Start: ${caption}`,
  switchesError: 'Demo switches not set',
  confirmOutcome: (caption: string) => `Expected outcome: ${caption}`,
  /** Keyed by scenario id (web/src/lib/scenarios.ts). */
  meta: {
    'gst-fails': {
      setup: 'gst-fail.json · GSTIN ending Z9',
      outcome: 'PAN verified · GSTIN rejected · review task: PAN verified, GST verification failed',
    },
    duplicate: {
      setup: 'happy.json · Duplicate callbacks on',
      outcome: 'Each check applied once · extras marked Duplicate ignored · reaches Merchant created',
    },
    late: {
      setup: 'happy.json · Callback delay 45s · timeout 30s',
      outcome: 'Timed out · retried · late callback applied · reaches Merchant created',
    },
    'bank-change': {
      setup: 'high-risk.json · risk score 85',
      outcome: 'In review: High risk score · bank change re-verifies bank only · approval withheld until it passes',
    },
    'merchant-fails': {
      setup: 'happy.json · Merchant ID service failing',
      outcome: 'Approved · MID creation fails · Merchant ID failed · retry available',
    },
    document: {
      setup: 'conflict.json · PAN card name differs from the form',
      outcome: "In review: Document doesn't match the form · pan-blurry.png upload gives Document image too blurry",
    },
  } as Record<string, { setup: string; outcome: string }>,
} as const

export const DEAD_LETTERS = {
  title: 'Dead letters',
  subtitle: 'Background steps that exhausted their retries.',
  loading: 'Loading dead letters',
  empty: 'No dead letters',
  attempts: (a: number, max: number) => `${a}/${max} attempts`,
  application: (id: string) => `Application ${id}`,
  gaveUp: (when: string) => `Failed ${when}`,
  requeue: 'Requeue',
  requeueTitle: (job: string) => `Requeue: ${job}`,
  requeueText: 'The job runs again with a new retry budget.',
  notePlaceholder: 'e.g. Provider outage resolved',
  requeued: 'Job requeued',
  requeuedText: (job: string) => `${job} · running`,
  jobs: {
    extract: 'Extraction',
    start_verifications: 'Verification requests',
    verification_timeout: 'Verification timeout',
    approve: 'Approval',
    create_merchant: 'MID creation',
  } as Record<string, string>,
} as const

export const DEMO = {
  title: 'Demo controls',
  subtitle: 'Simulated provider behaviour. Switches apply to new requests.',
  resetAll: 'Reset all',
  deleteAll: 'Delete all data',
  modes: 'Failure modes',
  modesSub: 'Red switches are on',
  loading: 'Loading demo settings',
  delay: 'Callback delay',
  delaySub: 'Default 1.5s',
  seconds: 'Seconds',
  set: 'Set',
  delaySet: (s: number) => `Callback delay: ${s}s`,
  current: 'Current settings',
  wipeTitle: 'Delete all data?',
  wipeText: 'All applications, review tasks, jobs and audit entries are deleted and the switches reset. This cannot be undone.',
  wipeConfirm: 'Delete everything',
  wiped: 'All data deleted',
  wipedText: 'Switches reset',
  switches: {
    failGst: { label: 'Fail GST', meta: 'GST verification fails · PAN passes · review task opened' },
    duplicate: { label: 'Duplicate callback', meta: 'Each callback sent twice · second copy ignored' },
    drop: { label: 'Drop callback (timeout)', meta: 'No callbacks · timeout 30s · 2 retries · review task (~95s)' },
    late: { label: 'Late callback', meta: 'Callback delay 45s · timeout 30s · applied late (~50s)' },
    outage: { label: 'Provider outage', meta: 'Provider returns 503 · retries · Dead letters (~17s)' },
    merchant: { label: 'Fail merchant creation', meta: 'MID service fails · 3 attempts · Merchant ID failed' },
  },
} as const
