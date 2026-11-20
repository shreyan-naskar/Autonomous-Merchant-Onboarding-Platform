import type { Actor, ApplicationDetailDto } from '@app/shared'
import { time } from '../lib/format.ts'

const ACTOR: Record<Actor, { icon: string; style: string }> = {
  system: { icon: '⚙', style: 'bg-slate-200 text-slate-700' },
  operator: { icon: '👤', style: 'bg-violet-100 text-violet-800' },
  provider: { icon: '⇄', style: 'bg-sky-100 text-sky-800' },
  merchant: { icon: '🏪', style: 'bg-amber-100 text-amber-800' },
}

/** Vertical timeline of the audit log, oldest first. Values in `detail` are already masked by the API. */
export function Timeline({ entries }: { entries: ApplicationDetailDto['audit_log'] }) {
  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-6">
      {entries.map((a) => {
        const actor = ACTOR[a.actor]
        const hasDetail = a.detail !== null && !(typeof a.detail === 'object' && Object.keys(a.detail as object).length === 0)
        return (
          <li key={a.id} className="relative">
            <span
              title={a.actor}
              aria-label={a.actor}
              className={`absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full text-xs ring-4 ring-white ${actor.style}`}
            >
              {actor.icon}
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-mono text-xs text-slate-500 tabular-nums">{time(a.at)}</span>
              <span className="font-semibold">{a.event}</span>
              {a.to_state ? (
                <span className="font-mono text-xs text-slate-600">
                  {a.from_state ?? '∅'} → <b>{a.to_state}</b>
                </span>
              ) : (
                <span className="text-xs text-slate-400">no state change</span>
              )}
              <span className="text-xs text-slate-400">by {a.actor}</span>
            </div>
            {hasDetail && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">detail</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(a.detail, null, 2)}</pre>
              </details>
            )}
          </li>
        )
      })}
    </ol>
  )
}
