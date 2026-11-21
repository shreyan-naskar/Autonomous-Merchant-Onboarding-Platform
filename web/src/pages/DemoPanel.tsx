import type { ChaosConfig } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../components/toast.tsx'
import { Button, Card, Dialog, ErrorAlert, Input, PageHeader, SkeletonRows, Switch } from '../components/ui.tsx'
import { api, mockApi } from '../lib/api.ts'
import { qk, useChaos, useMerchantService } from '../lib/queries.ts'

/** Late callbacks arrive after this delay: longer than the API's 30s demo timeout, so the API times out and retries first. */
export const LATE_MS = 45_000

export interface ChaosMode {
  key: string
  label: string
  /** What switching it on demonstrates (one line, for the audience). */
  demonstrates: string
  on: boolean
  set: (on: boolean) => void
}

/** The demo switches, shared with the "active chaos" banner. */
export function useChaosModes(): { modes: ChaosMode[]; loading: boolean; busy: boolean; error: unknown; resetAll: () => void } {
  const qc = useQueryClient()
  const chaos = useChaos()
  const merchant = useMerchantService()
  const setChaos = useMutation({
    mutationFn: (patch: Partial<ChaosConfig>) => mockApi.post<ChaosConfig>('/admin/config', patch),
    onSuccess: (data) => qc.setQueryData(qk.chaos, data),
  })
  const setMerchant = useMutation({
    mutationFn: (fail: boolean) => api.post<{ fail: boolean }>('/admin/merchant-service', { fail }),
    onSuccess: (data) => qc.setQueryData(qk.merchantService, data),
  })
  const reset = useMutation({
    mutationFn: async () => {
      await mockApi.post('/admin/reset')
      await api.post('/admin/merchant-service', { fail: false })
    },
    onSuccess: () => qc.invalidateQueries(),
  })
  const c = chaos.data
  const modes: ChaosMode[] = c
    ? [
        {
          key: 'failGst',
          label: 'Fail GST',
          demonstrates: 'PAN passes but the GST provider rejects every check: the application goes to review ("PAN verified, GST verification failed").',
          on: c.failKinds.includes('GST'),
          set: (on) => setChaos.mutate({ failKinds: on ? [...c.failKinds, 'GST'] : c.failKinds.filter((k) => k !== 'GST') }),
        },
        {
          key: 'duplicate',
          label: 'Duplicate callback',
          demonstrates: 'Providers send every answer twice. The second copy is recorded and ignored, so nothing happens twice.',
          on: c.duplicateCallback,
          set: (on) => setChaos.mutate({ duplicateCallback: on }),
        },
        {
          key: 'drop',
          label: 'Drop callback (timeout)',
          demonstrates: 'Providers never answer: after 30 s the request times out, is retried twice, then goes to review (about 95 s).',
          on: c.dropCallback,
          set: (on) => setChaos.mutate({ dropCallback: on }),
        },
        {
          key: 'late',
          label: 'Late callback',
          demonstrates: `Answers arrive after ${LATE_MS / 1000} s, after the 30 s timeout. They are still recorded and applied (about 50 s in total).`,
          on: c.lateCallbackMs > 0,
          set: (on) => setChaos.mutate({ lateCallbackMs: on ? LATE_MS : 0 }),
        },
        {
          key: 'outage',
          label: 'Provider outage',
          demonstrates: 'Providers refuse every request. The step is retried with backoff, then lands in Dead letters (about 17 s); requeue it after switching this off.',
          on: c.outage,
          set: (on) => setChaos.mutate({ outage: on }),
        },
        {
          key: 'merchant',
          label: 'Fail merchant creation',
          demonstrates: 'The merchant ID service fails: 3 attempts with backoff, then "Merchant ID failed" with a retry button for the reviewer.',
          on: merchant.data?.fail ?? false,
          set: (on) => setMerchant.mutate(on),
        },
      ]
    : []
  return {
    modes,
    loading: chaos.isPending,
    busy: setChaos.isPending || setMerchant.isPending || reset.isPending,
    error: chaos.error ?? setChaos.error ?? setMerchant.error ?? reset.error,
    resetAll: () => reset.mutate(),
  }
}

/** Demo controls: chaos switches for the mock providers and the merchant ID service, callback delay, reset, delete all data. */
export function DemoPanel() {
  const qc = useQueryClient()
  const toast = useToast()
  const chaos = useChaos()
  const { modes, loading, busy, error, resetAll } = useChaosModes()
  const [confirmWipe, setConfirmWipe] = useState(false)
  const setDelay = useMutation({
    mutationFn: (delayMs: number) => mockApi.post<ChaosConfig>('/admin/config', { delayMs }),
    onSuccess: (data) => {
      qc.setQueryData(qk.chaos, data)
      toast.push({ tone: 'success', title: `Callback delay set to ${data.delayMs / 1000} s` })
    },
  })
  const wipe = useMutation({
    mutationFn: async () => {
      await api.post('/admin/reset-data')
      await mockApi.post('/admin/reset')
      await api.post('/admin/merchant-service', { fail: false })
    },
    onSuccess: async () => {
      setConfirmWipe(false)
      toast.push({ tone: 'success', title: 'All data deleted', message: 'Switches are back to normal.' })
      await qc.invalidateQueries()
    },
  })
  // Reset all also restores the default callback delay (1.5 s).
  const anyOn = modes.some((m) => m.on) || (chaos.data !== undefined && chaos.data.delayMs !== 1500)

  return (
    <>
      <PageHeader
        title="Demo controls"
        subtitle="Make the simulated providers misbehave to show each failure path. Switches affect requests made after you flip them."
        actions={
          <>
            <Button icon={RotateCcw} onClick={resetAll} disabled={busy || !anyOn}>
              Reset all
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmWipe(true)} disabled={busy}>
              Delete all data
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Failure modes" subtitle="Red means on" className="lg:col-span-2">
          {error ? <ErrorAlert error={error} /> : null}
          {loading ? (
            <SkeletonRows rows={5} label="Loading demo settings" />
          ) : (
            <ul className="divide-y divide-neutral-100">
              {modes.map((m) => (
                <li key={m.key} className="py-3 first:pt-0 last:pb-0">
                  <Switch label={m.label} description={m.demonstrates} checked={m.on} onChange={m.set} disabled={busy} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-5">
          <Card title="Callback delay" subtitle="How long providers take to answer (default 1.5 s). Longer makes callbacks easier to watch.">
            {chaos.data && (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const v = Number(new FormData(e.currentTarget).get('delay'))
                  if (Number.isFinite(v) && v >= 0) setDelay.mutate(Math.round(v * 1000))
                }}
                className="flex items-end gap-2"
              >
                <div className="flex-1">
                  <Input key={chaos.data.delayMs} name="delay" label="Seconds" type="number" min={0} step={0.5} defaultValue={chaos.data.delayMs / 1000} />
                </div>
                <Button type="submit" loading={setDelay.isPending}>
                  Set
                </Button>
              </form>
            )}
          </Card>
          <Card title="Current settings">
            <pre className="overflow-x-auto rounded-control bg-neutral-50 p-2 font-mono text-2xs text-neutral-700">{chaos.data ? JSON.stringify(chaos.data, null, 2) : '—'}</pre>
          </Card>
        </div>
      </div>
      <Dialog
        open={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        title="Delete all data?"
        description="Every application, review task, job and audit entry is deleted, and the switches go back to normal. This cannot be undone. (Demo mode only.)"
        footer={
          <>
            <Button onClick={() => setConfirmWipe(false)}>Cancel</Button>
            <Button variant="danger" icon={Trash2} loading={wipe.isPending} onClick={() => wipe.mutate()}>
              Delete everything
            </Button>
          </>
        }
      >
        {wipe.error ? <ErrorAlert error={wipe.error} /> : null}
      </Dialog>
    </>
  )
}
