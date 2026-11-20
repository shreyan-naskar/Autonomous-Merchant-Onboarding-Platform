import { VERIFICATION_KINDS, type ApplicationDetailDto, type VerificationStatus } from '@app/shared'
import { time } from '../lib/format.ts'

const STATUS: Record<VerificationStatus, string> = {
  PENDING: 'border-blue-200 bg-blue-50 text-blue-800',
  PASSED: 'border-green-200 bg-green-50 text-green-800',
  FAILED: 'border-red-200 bg-red-50 text-red-800',
  TIMED_OUT: 'border-amber-200 bg-amber-50 text-amber-800',
}

/**
 * One card per check. Shows the row the API marks `is_current` (the one
 * the approval guard looks at); other attempts are listed underneath. Late and duplicate markers come from the audit log
 * and the callbacks list.
 */
export function VerificationCards({ app }: { app: ApplicationDetailDto }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {VERIFICATION_KINDS.map((kind) => {
        const rows = app.verifications.filter((v) => v.kind === kind)
        const current = rows.find((v) => v.is_current)
        const late = app.audit_log.filter((a) => a.event === 'LATE_CALLBACK' && (a.detail as { kind?: string } | null)?.kind === kind)
        const stale = app.audit_log.filter((a) => a.event === 'STALE_CALLBACK' && (a.detail as { kind?: string } | null)?.kind === kind)
        const dupes = app.callbacks.filter((c) => c.kind === kind && c.is_duplicate)
        return (
          <div key={kind} className={`rounded-lg border p-3 ${current ? STATUS[current.status] : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">{kind}</span>
              <span className="font-mono text-xs font-semibold">{current?.status ?? 'NOT STARTED'}</span>
            </div>
            {current && (
              <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs">
                <dt>Attempt</dt>
                <dd className="tabular-nums">{current.attempt}</dd>
                {kind === 'BANK' && (
                  <>
                    <dt>Bank version</dt>
                    <dd className="tabular-nums">{current.bank_version}</dd>
                  </>
                )}
                {kind === 'RISK' && (
                  <>
                    <dt>Risk score</dt>
                    <dd className={`tabular-nums font-semibold ${(current.score ?? 0) > 70 ? 'text-red-700' : ''}`}>{current.score ?? '—'}</dd>
                  </>
                )}
                <dt>Requested</dt>
                <dd>{time(current.requested_at)}</dd>
                <dt>Completed</dt>
                <dd>{current.completed_at ? time(current.completed_at) : '—'}</dd>
              </dl>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {late.length > 0 && <Marker style="bg-amber-200 text-amber-900">late ×{late.length}</Marker>}
              {dupes.length > 0 && <Marker style="bg-purple-200 text-purple-900">duplicate ignored ×{dupes.length}</Marker>}
              {stale.length > 0 && <Marker style="bg-slate-200 text-slate-700">stale ×{stale.length}</Marker>}
            </div>
            {rows.length > 1 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer">{rows.length} attempts</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {rows.map((v) => (
                    <li key={v.id} className={v.superseded ? 'line-through opacity-60' : ''}>
                      #{v.attempt} {v.status}
                      {kind === 'BANK' ? ` v${v.bank_version}` : ''}
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

function Marker({ style, children }: { style: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${style}`}>{children}</span>
}
