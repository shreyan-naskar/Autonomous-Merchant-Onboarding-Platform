import type { ChaosConfig } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, mockApi } from './api.ts'
import { qk, useChaos, useMerchantService } from './queries.ts'
import { DEMO } from '../copy.ts'

/** Longer than the API's 30s demo timeout, so the API times out and retries first. */
const LATE_MS = 45_000

interface ChaosMode {
  key: string
  label: string
  demonstrates: string
  on: boolean
  set: (on: boolean) => void
}

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
          label: DEMO.switches.failGst.label,
          demonstrates: DEMO.switches.failGst.meta,
          on: c.failKinds.includes('GST'),
          set: (on) => setChaos.mutate({ failKinds: on ? [...c.failKinds, 'GST'] : c.failKinds.filter((k) => k !== 'GST') }),
        },
        {
          key: 'duplicate',
          label: DEMO.switches.duplicate.label,
          demonstrates: DEMO.switches.duplicate.meta,
          on: c.duplicateCallback,
          set: (on) => setChaos.mutate({ duplicateCallback: on }),
        },
        {
          key: 'drop',
          label: DEMO.switches.drop.label,
          demonstrates: DEMO.switches.drop.meta,
          on: c.dropCallback,
          set: (on) => setChaos.mutate({ dropCallback: on }),
        },
        {
          key: 'late',
          label: DEMO.switches.late.label,
          demonstrates: DEMO.switches.late.meta,
          on: c.lateCallbackMs > 0,
          set: (on) => setChaos.mutate({ lateCallbackMs: on ? LATE_MS : 0 }),
        },
        {
          key: 'outage',
          label: DEMO.switches.outage.label,
          demonstrates: DEMO.switches.outage.meta,
          on: c.outage,
          set: (on) => setChaos.mutate({ outage: on }),
        },
        {
          key: 'merchant',
          label: DEMO.switches.merchant.label,
          demonstrates: DEMO.switches.merchant.meta,
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
