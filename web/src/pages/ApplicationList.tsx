import { APPLICATION_STATUSES, type ApplicationListDto } from '@app/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { Card, ErrorBox, Loading, inputClass } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { duration } from '../lib/format.ts'

export function ApplicationList() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const navigate = useNavigate()
  const { data, error, isPending } = useQuery({
    queryKey: ['applications', status],
    queryFn: () => api.get<ApplicationListDto>(`/applications${status ? `?status=${status}` : ''}`),
  })

  return (
    <Card
      title={`Applications${data ? ` (${data.count})` : ''}`}
      actions={
        <select
          aria-label="Filter by status"
          className={`${inputClass} w-auto`}
          value={status}
          onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}
        >
          <option value="">All states</option>
          {APPLICATION_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      }
    >
      <ErrorBox error={error} />
      {isPending && <Loading />}
      {data && data.items.length === 0 && (
        <p className="text-sm text-slate-500">
          No applications yet. <Link className="underline" to="/submit">Submit one</Link>.
        </p>
      )}
      {data && data.items.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2">Merchant</th>
              <th>Status</th>
              <th>Time in state</th>
              <th>Open reviews</th>
              <th>Merchant ID</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((a) => (
              <tr
                key={a.id}
                onClick={() => navigate(`/applications/${a.id}`)}
                className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="py-2">
                  <Link to={`/applications/${a.id}`} className="font-medium text-slate-900 hover:underline">
                    {a.merchant_name}
                  </Link>
                </td>
                <td>
                  <StatusBadge status={a.status} />
                </td>
                <td className="tabular-nums">{duration(a.time_in_state_ms)}</td>
                <td>
                  {a.open_review_count > 0 ? (
                    <span className="rounded-full bg-orange-500 px-2 py-0.5 text-xs font-semibold text-white">{a.open_review_count}</span>
                  ) : (
                    <span className="text-slate-400">0</span>
                  )}
                </td>
                <td className="font-mono text-xs">{a.merchant_id ?? '—'}</td>
                <td className="text-slate-500">{new Date(a.created_at).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
