import type { ChaosConfig } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, mockApi } from './api.ts'
import { qk, useChaos, useMerchantService } from './queries.ts'

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
