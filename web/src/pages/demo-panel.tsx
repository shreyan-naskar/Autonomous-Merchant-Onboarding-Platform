import type { ChaosConfig } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../lib/toast.ts'
import { Button, Card, Dialog, ErrorAlert, Input, PageHeader, SkeletonRows, Switch } from '../components/ui.tsx'
import { api, mockApi } from '../lib/api.ts'
import { useChaosModes } from '../lib/chaos.ts'
import { qk, useChaos } from '../lib/queries.ts'
import { COMMON, DEMO as C } from '../copy.ts'

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
      toast.push({ tone: 'success', title: C.delaySet(data.delayMs / 1000) })
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
      toast.push({ tone: 'success', title: C.wiped, message: C.wipedText })
      await qc.invalidateQueries()
    },
  })
  // Reset all also restores the default callback delay (1.5 s).
  const anyOn = modes.some((m) => m.on) || (chaos.data !== undefined && chaos.data.delayMs !== 1500)

  return (
    <>
      <PageHeader
        title={C.title}
        subtitle={C.subtitle}
        actions={
          <>
            <Button icon={RotateCcw} onClick={resetAll} disabled={busy || !anyOn}>
              {C.resetAll}
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmWipe(true)} disabled={busy}>
              {C.deleteAll}
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={C.modes} subtitle={C.modesSub} className="lg:col-span-2">
          {error ? <ErrorAlert error={error} /> : null}
          {loading ? (
            <SkeletonRows rows={5} label={C.loading} />
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
          <Card title={C.delay} subtitle={C.delaySub}>
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
                  <Input key={chaos.data.delayMs} name="delay" label={C.seconds} type="number" min={0} step={0.5} defaultValue={chaos.data.delayMs / 1000} />
                </div>
                <Button type="submit" loading={setDelay.isPending}>
                  {C.set}
                </Button>
              </form>
            )}
          </Card>
          <Card title={C.current}>
            <pre className="overflow-x-auto rounded-control bg-neutral-50 p-2 font-mono text-2xs text-neutral-700">{chaos.data ? JSON.stringify(chaos.data, null, 2) : '—'}</pre>
          </Card>
        </div>
      </div>
      <Dialog
        open={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        title={C.wipeTitle}
        description={C.wipeText}
        footer={
          <>
            <Button onClick={() => setConfirmWipe(false)}>{COMMON.cancel}</Button>
            <Button variant="danger" icon={Trash2} loading={wipe.isPending} onClick={() => wipe.mutate()}>
              {C.wipeConfirm}
            </Button>
          </>
        }
      >
        {wipe.error ? <ErrorAlert error={wipe.error} /> : null}
      </Dialog>
    </>
  )
}
