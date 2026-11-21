import {
  ACTOR_LABELS,
  CHECK_LABELS,
  DOCUMENT_LABELS,
  EVENT_LABELS,
  STATUS_LABELS,
  VALIDATION_LABELS,
  VERIFICATION_KINDS,
  VERIFICATION_STATUS_LABELS,
  humanize,
  type Actor,
  type ApplicationDetailDto,
  type ApplicationStatus,
  type AuditEvent,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Building2,
  Check,
  ChevronDown,
  Cog,
  FileImage,
  FileJson,
  FileText,
  Landmark,
  Radio,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, fieldErrors } from '../lib/api.ts'
import { dateTime, relativeTime, time } from '../lib/format.ts'
import { SEVERITY_ICON, STATUS_ICON, toneOf } from '../lib/status.ts'
import { useToast } from '../lib/toast.ts'
import { Badge, Button, EmptyState, ErrorAlert, Input, Tooltip } from './ui.tsx'
import { TONE_SOFT, cx, type Tone } from '../lib/tone.ts'

type App = ApplicationDetailDto


const STEPS: readonly ApplicationStatus[] = ['SUBMITTED', 'EXTRACTING', 'VERIFYING', 'VERIFIED', 'APPROVED', 'MERCHANT_CREATED']
const STEP_NAMES: Record<string, string> = {
  SUBMITTED: 'Submitted',
  EXTRACTING: 'Extracting',
  VERIFYING: 'Verifying',
  VERIFIED: 'Verified',
  APPROVED: 'Approved',
  MERCHANT_CREATED: 'Merchant created',
}

function stepState(app: App): { index: number; branch?: { status: ApplicationStatus; tone: Tone } } {
  const at = STEPS.indexOf(app.status)
  if (at >= 0) return { index: at }
  // An exception state branches off the last happy-path step it reached.
  const reached = app.audit_log
    .map((a) => a.to_state)
    .filter((s): s is ApplicationStatus => s !== null && STEPS.includes(s))
    .map((s) => STEPS.indexOf(s))
  const last = reached.length ? Math.max(...reached) : 0
  const tone: Tone = app.status === 'REJECTED' || app.status === 'MERCHANT_CREATION_FAILED' ? 'danger' : 'warning'
  return { index: last, branch: { status: app.status, tone } }
}

export function Stepper({ app }: { app: App }) {
  const { index, branch } = stepState(app)
  return (
    <ol aria-label="Onboarding progress" className="flex w-full items-start overflow-x-auto pb-1">
      {STEPS.map((s, i) => {
        const done = i < index || (i === index && !branch && s === 'MERCHANT_CREATED')
        const current = i === index && !done
        const branched = current && branch
        const BranchIcon = branch ? STATUS_ICON[branch.status] : null
        return (
          <li key={s} className="relative flex min-w-24 flex-1 flex-col items-center text-center" aria-current={current ? 'step' : undefined}>
            {i > 0 && <span aria-hidden className={cx('absolute top-3.5 right-1/2 h-0.5 w-full', i <= index ? 'bg-accent-600' : 'bg-neutral-200')} />}
            <span
              className={cx(
                'relative z-10 flex size-7 items-center justify-center rounded-full text-xs font-semibold ring-4 ring-white',
                done && 'bg-accent-700 text-white',
                current && !branched && 'bg-white text-accent-800 ring-2 ring-accent-600 ring-offset-2',
                branched && (branch!.tone === 'danger' ? 'bg-danger-600 text-white' : 'bg-warning-500 text-white'),
                !done && !current && 'bg-neutral-100 text-neutral-400',
              )}
            >
              {done ? <Check aria-hidden className="size-4" /> : branched && BranchIcon ? <BranchIcon aria-hidden className="size-4" /> : i + 1}
            </span>
            <span className={cx('mt-1.5 text-xs', current || done ? 'font-medium text-neutral-800' : 'text-neutral-400')}>{STEP_NAMES[s]}</span>
            <span className="sr-only">{done ? '(done)' : current ? '(current)' : '(not yet)'}</span>
            {branched && (
              <span className={cx('mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset', TONE_SOFT[branch!.tone])}>
                ↳ {STATUS_LABELS[branch!.status].label}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}


const CARD_TONE: Record<string, string> = {
  PENDING: 'border-info-200 bg-info-50/60',
  PASSED: 'border-success-200 bg-success-50/60',
  FAILED: 'border-danger-200 bg-danger-50/60',
  TIMED_OUT: 'border-warning-200 bg-warning-50/60',
}

/** Shows the row the API marks is_current: the one the approval guard looks at. */
export function VerificationCards({ app }: { app: App }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {VERIFICATION_KINDS.map((kind) => {
        const rows = app.verifications.filter((v) => v.kind === kind)
        const current = rows.find((v) => v.is_current)
        const st = current ? VERIFICATION_STATUS_LABELS[current.status] : null
        const Icon = st ? SEVERITY_ICON[st.severity] : null
        const late = app.audit_log.filter((a) => a.event === 'LATE_CALLBACK' && (a.detail as { kind?: string } | null)?.kind === kind).length
        const stale = app.audit_log.filter((a) => a.event === 'STALE_CALLBACK' && (a.detail as { kind?: string } | null)?.kind === kind).length
        const dupes = app.callbacks.filter((c) => c.kind === kind && c.is_duplicate).length
        return (
          <div
            key={`${kind}-${current?.status ?? 'none'}`}
            className={cx('animate-fade-in rounded-card border p-3.5', current ? CARD_TONE[current.status] : 'border-dashed border-neutral-300 bg-white')}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-neutral-900">{CHECK_LABELS[kind]}</span>
              {st && Icon ? (
                <Tooltip content={`${st.description} (${current!.status})`}>
                  <span tabIndex={0} className="rounded-full">
                    <Badge tone={toneOf(st.severity)} icon={Icon}>
                      {st.label}
                    </Badge>
                  </span>
                </Tooltip>
              ) : (
                <Badge tone="neutral">{rows.length > 0 ? 'Re-checking' : 'Not started'}</Badge>
              )}
            </div>
            {current ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                <dt className="text-neutral-500">Attempt</dt>
                <dd className="tabular text-right text-neutral-800">{current.attempt}</dd>
                {kind === 'BANK' && (
                  <>
                    <dt className="text-neutral-500">Bank details version</dt>
                    <dd className="tabular text-right text-neutral-800">{current.bank_version}</dd>
                  </>
                )}
                {kind === 'RISK' && (
                  <>
                    <dt className="text-neutral-500">Risk score</dt>
                    <dd className={cx('tabular text-right font-semibold', (current.score ?? 0) > 70 ? 'text-danger-700' : 'text-neutral-800')}>
                      {current.score ?? '—'}
                      {(current.score ?? 0) > 70 && <span className="ml-1 font-normal">(high)</span>}
                    </dd>
                  </>
                )}
                <dt className="text-neutral-500">Requested</dt>
                <dd className="tabular text-right text-neutral-800">{time(current.requested_at)}</dd>
                <dt className="text-neutral-500">Answered</dt>
                <dd className="tabular text-right text-neutral-800">{current.completed_at ? time(current.completed_at) : '—'}</dd>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-neutral-500">
                {rows.length > 0 ? 'Being sent to the provider again (for example after a bank details change).' : 'Requested once extraction succeeds.'}
              </p>
            )}
            {(late > 0 || dupes > 0 || stale > 0) && (
              <div className="mt-3 flex flex-wrap gap-1">
                {late > 0 && (
                  <Badge tone="warning" title="Answer arrived after the request had timed out; it was recorded and applied.">
                    Late ×{late}
                  </Badge>
                )}
                {dupes > 0 && (
                  <Badge tone="info" title="The provider sent the same answer again; the copy was ignored.">
                    Duplicate ignored ×{dupes}
                  </Badge>
                )}
                {stale > 0 && (
                  <Badge tone="neutral" title="An answer for the old bank details was ignored.">
                    Stale ×{stale}
                  </Badge>
                )}
              </div>
            )}
            {rows.length > 1 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900">{rows.length} attempts</summary>
                <ul className="mt-1 space-y-0.5">
                  {rows.map((v) => (
                    <li key={v.id} className={cx('tabular', v.superseded && 'text-neutral-400 line-through')}>
                      #{v.attempt} {VERIFICATION_STATUS_LABELS[v.status].label}
                      {kind === 'BANK' ? ` (bank details v${v.bank_version})` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}


const FIELD_NAMES: Record<string, string> = {
  pan: 'PAN',
  name: 'Name on PAN card',
  gst: 'GSTIN',
  legal_name: 'Legal name',
  bank_account: 'Account number',
  ifsc: 'IFSC',
  account_holder: 'Account holder',
}

export function ExtractedFields({ app }: { app: App }) {
  const fields = app.extracted_fields
  if (fields.length === 0) {
    return <EmptyState icon={FileText} title="Nothing extracted yet" text="Fields appear here once the documents have been read." />
  }
  const docType = (id: number | null) => app.documents.find((d) => d.id === id)?.type
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs text-neutral-500">
          <tr className="border-b border-neutral-200">
            <th scope="col" className="py-2 pr-3 font-medium">Field</th>
            <th scope="col" className="py-2 pr-3 font-medium">Value</th>
            <th scope="col" className="w-44 py-2 pr-3 font-medium">Confidence</th>
            <th scope="col" className="py-2 font-medium">Check</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const pct = Math.round(f.confidence * 100)
            const v = VALIDATION_LABELS[f.validation_status]
            const t = docType(f.document_id)
            const bar = f.confidence >= 0.8 ? 'bg-success-500' : f.confidence >= 0.5 ? 'bg-warning-500' : 'bg-danger-500'
            return (
              <tr key={f.id} className="border-b border-neutral-100 last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium text-neutral-800">{FIELD_NAMES[f.field] ?? humanize(f.field)}</div>
                  {t && <div className="text-2xs text-neutral-500">{DOCUMENT_LABELS[t]}</div>}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-800">{f.value ?? <span className="text-neutral-400">—</span>}</td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 rounded-full bg-neutral-100" role="meter" aria-label={`Confidence ${pct}%`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                      <div className={cx('h-1.5 rounded-full', bar)} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="tabular text-xs text-neutral-600">{pct}%</span>
                  </div>
                </td>
                <td className="py-2">
                  <Tooltip content={`${v.description} (${f.validation_status})`}>
                    <span tabIndex={0} className="rounded-full">
                      <Badge tone={toneOf(v.severity)} icon={SEVERITY_ICON[v.severity]}>
                        {v.label}
                      </Badge>
                    </span>
                  </Tooltip>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


const ACTOR_ICON: Record<Actor, { icon: LucideIcon; tone: Tone }> = {
  system: { icon: Cog, tone: 'neutral' },
  operator: { icon: UserRoundCheck, tone: 'accent' },
  provider: { icon: Radio, tone: 'info' },
  merchant: { icon: Building2, tone: 'warning' },
}

export function Timeline({ entries }: { entries: App['audit_log'] }) {
  return (
    <ol className="relative space-y-4 border-l border-neutral-200 pl-6" aria-label="Audit trail">
      {entries.map((a) => {
        const actor = ACTOR_ICON[a.actor]
        const label = EVENT_LABELS[a.event as AuditEvent] ?? humanize(a.event)
        const d = (a.detail ?? {}) as { kind?: string; status?: string }
        const check = d.kind && d.kind in CHECK_LABELS ? CHECK_LABELS[d.kind as keyof typeof CHECK_LABELS] : null
        const answer = a.event === 'VERIFICATION_RESULT' || a.event === 'LATE_CALLBACK' ? d.status : undefined
        const answerLabel = answer && answer in VERIFICATION_STATUS_LABELS ? VERIFICATION_STATUS_LABELS[answer as keyof typeof VERIFICATION_STATUS_LABELS] : null
        const hasDetail = a.detail !== null && !(typeof a.detail === 'object' && Object.keys(a.detail as object).length === 0)
        return (
          <li key={a.id} className="relative">
            <span className={cx('absolute -left-[37px] flex size-6 items-center justify-center rounded-full ring-4 ring-white', TONE_SOFT[actor.tone])}>
              <actor.icon aria-hidden className="size-3.5" />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <Tooltip content={<span className="font-mono">{a.event}</span>}>
                <span tabIndex={0} className="text-sm font-medium text-neutral-900">
                  {label}
                  {check && <span className="font-normal text-neutral-600"> · {check}</span>}
                </span>
              </Tooltip>
              {answerLabel && (
                <Badge tone={toneOf(answerLabel.severity)} icon={SEVERITY_ICON[answerLabel.severity]}>
                  {answerLabel.label}
                </Badge>
              )}
              {a.to_state && (
                <span className="text-xs text-neutral-500">
                  {a.from_state ? `${STATUS_LABELS[a.from_state].label} → ` : ''}
                  <b className="font-medium text-neutral-700">{STATUS_LABELS[a.to_state].label}</b>
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {ACTOR_LABELS[a.actor]} · <time dateTime={a.at} title={dateTime(a.at)}>{time(a.at)}</time>
            </div>
            {hasDetail && (
              <details className="group mt-1">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800">
                  <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
                  Details
                </summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-neutral-50 p-2 font-mono text-2xs text-neutral-700">{JSON.stringify(a.detail, null, 2)}</pre>
              </details>
            )}
          </li>
        )
      })}
    </ol>
  )
}


export function DocumentsList({ app }: { app: App }) {
  if (app.documents.length === 0) return <EmptyState icon={FileText} title="No documents" text="This application was submitted without documents." />
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {app.documents.map((d) => {
        const isFile = d.file_name !== null
        const Icon = !isFile ? FileJson : /\.(png|jpe?g)$/i.test(d.file_name!) ? FileImage : FileText
        const fields = app.extracted_fields.filter((f) => f.document_id === d.id)
        const blurry = d.blur_score !== null && d.blur_score < 30
        return (
          <li key={d.id} className="rounded-card border border-neutral-200 bg-white p-4 shadow-card">
            <div className="flex items-start gap-3">
              <span className="rounded-md bg-neutral-100 p-2 text-neutral-600">
                <Icon aria-hidden className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-neutral-900">{DOCUMENT_LABELS[d.type]}</div>
                <div className="truncate text-xs text-neutral-500">{isFile ? `Uploaded file · ${d.file_name}` : 'Structured data (JSON)'}</div>
                <div className="text-2xs text-neutral-400">added {relativeTime(d.created_at)}</div>
              </div>
            </div>
            {d.blur_score !== null && (
              <div className="mt-3">
                <Badge tone={blurry ? 'warning' : 'success'} icon={blurry ? SEVERITY_ICON.warning : SEVERITY_ICON.success} title="Laplacian variance; below 30 is too blurry to read">
                  Sharpness {Math.round(d.blur_score)} {blurry ? '(blurry)' : '(sharp)'}
                </Badge>
              </div>
            )}
            {fields.length > 0 && (
              <dl className="mt-3 space-y-1 text-xs">
                {fields.map((f) => (
                  <div key={f.id} className="flex justify-between gap-3">
                    <dt className="text-neutral-500">{FIELD_NAMES[f.field] ?? humanize(f.field)}</dt>
                    <dd className="truncate font-mono text-neutral-800">{f.value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        )
      })}
    </ul>
  )
}


export function BankDetails({ app }: { app: App }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [account, setAccount] = useState('')
  const [ifsc, setIfsc] = useState('')
  const change = useMutation({
    mutationFn: () =>
      api.patch<App>(`/applications/${app.id}`, {
        ...(account ? { bank_account: account.trim() } : {}),
        ...(ifsc ? { ifsc: ifsc.trim().toUpperCase() } : {}),
      }),
    onSuccess: async (updated) => {
      setAccount('')
      setIfsc('')
      toast.push({ tone: 'success', title: 'Bank details updated', message: `Now ${STATUS_LABELS[updated.status].label.toLowerCase()}; the new account will be verified.` })
      await qc.invalidateQueries()
    },
  })
  const errs = fieldErrors(change.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    change.mutate()
  }
  const bankRows = app.verifications.filter((v) => v.kind === 'BANK')
  const locked = ['APPROVED', 'MERCHANT_CREATED', 'MERCHANT_CREATION_FAILED', 'REJECTED'].includes(app.status)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <dl className="grid grid-cols-3 gap-3 rounded-card border border-neutral-200 bg-white p-4 text-sm shadow-card">
          <div>
            <dt className="text-xs text-neutral-500">Account</dt>
            <dd className="font-mono text-neutral-900">{app.bank_account ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">IFSC</dt>
            <dd className="font-mono text-neutral-900">{app.ifsc ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Version</dt>
            <dd className="tabular text-neutral-900">{app.bank_version}</dd>
          </div>
        </dl>
        <div className="rounded-card border border-neutral-200 bg-white p-4 shadow-card">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
            <Landmark aria-hidden className="size-4" /> Bank account checks
          </h3>
          {bankRows.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">Not requested yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {bankRows.map((v) => {
                const st = VERIFICATION_STATUS_LABELS[v.status]
                return (
                  <li key={v.id} className={cx('flex items-center justify-between gap-2', v.superseded && 'opacity-60')}>
                    <span className="text-neutral-700">
                      Bank details v{v.bank_version}, attempt {v.attempt}
                      {v.superseded && <span className="ml-1 text-xs text-neutral-500">(replaced)</span>}
                    </span>
                    <Badge tone={toneOf(st.severity)} icon={SEVERITY_ICON[st.severity]}>
                      {st.label}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      <form onSubmit={submit} className="space-y-3 rounded-card border border-neutral-200 bg-white p-4 shadow-card" aria-labelledby="bank-change-title">
        <h3 id="bank-change-title" className="text-sm font-semibold text-neutral-900">
          Change bank details (as the merchant)
        </h3>
        <p className="text-xs text-neutral-500">
          After verification, a change sends the new account to the bank provider again; approval waits until it passes.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="New account number" inputMode="numeric" autoComplete="off" placeholder="60200111122223" value={account} onChange={(e) => setAccount(e.target.value)} error={errs.bank_account} disabled={locked} />
          <Input label="New IFSC" autoComplete="off" placeholder="ICIC0009999" value={ifsc} onChange={(e) => setIfsc(e.target.value)} error={errs.ifsc} disabled={locked} />
        </div>
        {change.error && !Object.keys(errs).length && <ErrorAlert error={change.error} />}
        {locked ? (
          <p className="text-xs text-neutral-500">Bank details can no longer be changed in this state.</p>
        ) : (
          <Button type="submit" variant="secondary" icon={Landmark} loading={change.isPending} disabled={!account && !ifsc}>
            Change bank details
          </Button>
        )}
      </form>
    </div>
  )
}

