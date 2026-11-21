import type { ChaosConfig } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../lib/toast.ts'
import { Button, Card, Dialog, ErrorAlert, Input, PageHeader, SkeletonRows, Switch } from '../components/ui.tsx'
import { api, mockApi } from '../lib/api.ts'
import { useChaosModes } from '../lib/chaos.ts'
import { qk, useChaos } from '../lib/queries.ts'

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
