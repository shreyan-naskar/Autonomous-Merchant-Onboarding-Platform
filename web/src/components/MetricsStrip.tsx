import type { MetricsDto } from '@app/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { duration } from '../lib/format.ts'

/** Totals and average time per state, from GET /metrics (computed by the API from the audit log). */
export function MetricsStrip() {
  const { data, error } = useQuery({ queryKey: ['metrics'], queryFn: () => api.get<MetricsDto>('/metrics') })
  if (error) return <div className="text-xs text-red-700">Metrics unavailable: {error.message}</div>
  if (!data) return null
  return (
    <div className="flex flex-wrap items-stretch gap-2 text-xs">
      <Tile label="Applications" value={String(data.total_applications)} />
      <Tile
        label="Exception rate"
        value={`${Math.round(data.exception_rate * 100)}%`}
        sub={`${data.exception_count} hit IN_REVIEW / NEEDS_INFO`}
      />
      <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 rounded border border-slate-200 bg-white px-3 py-2">
        <span className="font-semibold text-slate-500">Avg time in state</span>
        {data.states
          .filter((s) => s.completed > 0 || s.current > 0)
          .map((s) => (
            <span key={s.state} title={`${s.completed} completed stays, ${s.current} now`}>
              <span className="font-mono text-slate-500">{s.state}</span>{' '}
              <span className="font-semibold tabular-nums">{s.avg_ms === null ? '—' : duration(s.avg_ms)}</span>
              {s.current > 0 && <span className="text-slate-400"> ({s.current} now)</span>}
            </span>
          ))}
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2">
      <div className="text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  )
}
