import type { ChaosConfig, MerchantServiceConfig } from '@app/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, ErrorBox, Loading, buttonClass, inputClass, PageHeader } from '../components/ui.tsx'
import { api, mockApi } from '../lib/api.ts'

/** Late callbacks arrive after this delay: longer than the API's 30s demo timeout, so the API times out and retries first. */
const LATE_MS = 45_000

/**
 * Demo controls: chaos settings of the mock providers (via /mock) and the
 * API's simulated merchant ID service (via /api). Settings apply to provider
 * requests made after the change.
 */
export function DemoPanel() {
  const qc = useQueryClient()
  const chaos = useQuery({ queryKey: ['mock-config'], queryFn: () => mockApi.get<ChaosConfig>('/admin/config') })
  const merchant = useQuery({ queryKey: ['merchant-service'], queryFn: () => api.get<MerchantServiceConfig>('/admin/merchant-service') })

  const setChaos = useMutation({
    mutationFn: (patch: Partial<ChaosConfig>) => mockApi.post<ChaosConfig>('/admin/config', patch),
    onSuccess: (data) => qc.setQueryData(['mock-config'], data),
  })
  const setMerchant = useMutation({
    mutationFn: (fail: boolean) => api.post<MerchantServiceConfig>('/admin/merchant-service', { fail }),
    onSuccess: (data) => qc.setQueryData(['merchant-service'], data),
  })
  const reset = useMutation({
    mutationFn: async () => {
      await mockApi.post('/admin/reset')
      await api.post('/admin/merchant-service', { fail: false })
    },
    onSuccess: () => qc.invalidateQueries(),
  })
  // Demo mode only (the API answers 404 otherwise): deletes every application, then resets the switches.
  const wipe = useMutation({
    mutationFn: async () => {
      await api.post('/admin/reset-data')
      await mockApi.post('/admin/reset')
      await api.post('/admin/merchant-service', { fail: false })
    },
    onSuccess: () => qc.invalidateQueries(),
  })

  const c = chaos.data
  const busy = setChaos.isPending || setMerchant.isPending || reset.isPending || wipe.isPending
  const toggles: { label: string; help: string; on: boolean; set: (on: boolean) => void }[] = c
    ? [
        {
          label: 'Fail GST',
          help: 'GST provider fails every check (PAN still passes) -> IN_REVIEW PAN_OK_GST_FAILED',
          on: c.failKinds.includes('GST'),
          set: (on) => setChaos.mutate({ failKinds: on ? [...c.failKinds, 'GST'] : c.failKinds.filter((k) => k !== 'GST') }),
        },
        {
          label: 'Duplicate callback',
          help: 'Every callback is sent twice with the same event_id; the API ignores the second',
          on: c.duplicateCallback,
          set: (on) => setChaos.mutate({ duplicateCallback: on }),
        },
        {
          label: 'Drop callback (timeout)',
          help: 'No callbacks: the API times out after 30s, retries twice, then IN_REVIEW <KIND>_TIMEOUT',
          on: c.dropCallback,
          set: (on) => setChaos.mutate({ dropCallback: on }),
        },
        {
          label: 'Late callback',
          help: `Callbacks arrive after ${LATE_MS / 1000}s, after the 30s timeout: recorded as LATE_CALLBACK and reconciled`,
          on: c.lateCallbackMs > 0,
          set: (on) => setChaos.mutate({ lateCallbackMs: on ? LATE_MS : 0 }),
        },
        {
          label: 'Provider outage',
          help: 'Providers refuse every request (503): the API retries with backoff (1s, 2s, 4s, 8s), then the job goes to Dead letters (requeue it there once this is off)',
          on: c.outage,
          set: (on) => setChaos.mutate({ outage: on }),
        },
        {
          label: 'Fail merchant creation',
          help: 'Merchant ID service fails: 3 attempts with backoff, then MERCHANT_CREATION_FAILED',
          on: merchant.data?.fail ?? false,
          set: (on) => setMerchant.mutate(on),
        },
      ]
    : []

  return (
    <>
    <PageHeader title="Demo controls" subtitle="Make the simulated providers misbehave to show each failure path." />
    <div className="space-y-4">
      <Card
        title="Demo controls"
        actions={
          <div className="flex gap-2">
            <button className={buttonClass.secondary} disabled={busy} onClick={() => reset.mutate()}>
              Reset all
            </button>
            <button
              className={buttonClass.secondary}
              disabled={busy}
              title="Delete every application, review task, job and audit entry (demo mode only), and reset the switches"
              onClick={() => {
                if (window.confirm('Delete ALL applications and their history? This cannot be undone.')) wipe.mutate()
              }}
            >
              Delete all data
            </button>
          </div>
        }
      >
        {(chaos.isPending || merchant.isPending) && <Loading />}
        <ErrorBox error={chaos.error ?? merchant.error ?? setChaos.error ?? setMerchant.error ?? reset.error ?? wipe.error} />
        <ul className="divide-y divide-slate-100">
          {toggles.map((t) => (
            <li key={t.label} className="flex items-center justify-between gap-4 py-2">
              <div>
                <div className="text-sm font-medium">{t.label}</div>
                <div className="text-xs text-slate-500">{t.help}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={t.on}
                aria-label={t.label}
                disabled={busy}
                onClick={() => t.set(!t.on)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${t.on ? 'bg-red-500' : 'bg-slate-300'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${t.on ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </li>
          ))}
        </ul>
        {c && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            Callback delay (ms)
            <input
              type="number"
              min={0}
              step={500}
              className={`${inputClass} w-28`}
              defaultValue={c.delayMs}
              key={c.delayMs}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (Number.isInteger(v) && v >= 0 && v !== c.delayMs) setChaos.mutate({ delayMs: v })
              }}
            />
          </label>
        )}
      </Card>
      <Card title="Current configuration">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold text-slate-500">Mock providers (/mock/admin/config)</h3>
            <pre className="rounded bg-slate-50 p-2 text-xs">{c ? JSON.stringify(c, null, 2) : '—'}</pre>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold text-slate-500">Merchant ID service (/api/admin/merchant-service)</h3>
            <pre className="rounded bg-slate-50 p-2 text-xs">{merchant.data ? JSON.stringify(merchant.data, null, 2) : '—'}</pre>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Magic values work without toggles: PAN <code>ZZZZZ9999Z</code> fails, GSTIN ending <code>Z9</code> fails, account ending{' '}
          <code>0000</code> never answers, a name containing <code>RISKY</code> scores 85.
        </p>
      </Card>
    </div>
    </>
  )
}
