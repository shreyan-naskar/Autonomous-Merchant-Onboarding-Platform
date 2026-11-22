import type { ChaosConfig, DocumentType } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import conflict from '../../../sample-data/conflict.json'
import gstFail from '../../../sample-data/gst-fail.json'
import happy from '../../../sample-data/happy.json'
import highRisk from '../../../sample-data/high-risk.json'
import { api, mockApi } from './api.ts'
import { qk } from './queries.ts'

/** Matches LATE_MS in chaos.ts: longer than the API's 30 s demo timeout. */
const LATE_MS = 45_000

type Switches = Pick<ChaosConfig, 'failKinds' | 'duplicateCallback' | 'dropCallback' | 'lateCallbackMs' | 'outage'>

/** Every failure switch off; the callback delay is left as the presenter set it. */
const ALL_OFF: Switches = { failKinds: [], duplicateCallback: false, dropCallback: false, lateCallbackMs: 0, outage: false }

export interface ScenarioSample {
  merchant_name: string
  pan: string
  gst: string
  bank_account: string
  ifsc: string
  documents: { type: DocumentType; payload: Record<string, unknown> }[]
}

const sample = (json: unknown) => json as ScenarioSample

export interface Scenario {
  id: string
  /** Worded exactly as in the problem statement. */
  caption: string
  /** File name in sample-data/, for display. */
  sampleFile: string
  sample: ScenarioSample
  /** Demo switches this scenario turns on (all others are turned off). */
  switches: Partial<Switches>
  failMerchant: boolean
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'gst-fails',
    caption: 'PAN verification succeeds but GST verification fails.',
    sampleFile: 'gst-fail.json',
    sample: sample(gstFail),
    switches: {},
    failMerchant: false,
  },
  {
    id: 'duplicate',
    caption: 'The same callback arrives multiple times.',
    sampleFile: 'happy.json',
    sample: sample(happy),
    switches: { duplicateCallback: true },
    failMerchant: false,
  },
  {
    id: 'late',
    caption: 'A callback arrives after the request timed out.',
    sampleFile: 'happy.json',
    sample: sample(happy),
    switches: { lateCallbackMs: LATE_MS },
    failMerchant: false,
  },
  {
    id: 'bank-change',
    caption: 'The merchant changes bank details after verification.',
    sampleFile: 'high-risk.json',
    sample: sample(highRisk),
    switches: {},
    failMerchant: false,
  },
  {
    id: 'merchant-fails',
    caption: 'Approval succeeds but merchant ID creation fails.',
    sampleFile: 'happy.json',
    sample: sample(happy),
    switches: {},
    failMerchant: true,
  },
  {
    id: 'document',
    caption: 'A document is blurred or conflicts with the application form.',
    sampleFile: 'conflict.json',
    sample: sample(conflict),
    switches: {},
    failMerchant: false,
  },
]

/**
 * The same sample under new identifiers. Without this, running a scenario a
 * second time (or two scenarios on one sample) matches the earlier application
 * on PAN, GSTIN or bank account, and the duplicate check sends it to review
 * instead of down the path the scenario is meant to show. Only digits change,
 * so the GST magic suffix and the PAN-inside-GSTIN rule still hold.
 */
export function withFreshIdentifiers<T extends { pan?: unknown; bank_account?: unknown }>(sample: T, random: () => number = Math.random): T {
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 10)).join('')
  const pan = String(sample.pan ?? '')
  const account = String(sample.bank_account ?? '')
  const replacements: [string, string][] = []
  if (pan.length === 10) replacements.push([pan, `${pan.slice(0, 5)}${digits(4)}${pan.slice(9)}`])
  if (account.length > 6) {
    // Not ending in 0000: the mock bank provider never answers those (MAGIC.silentBankSuffix).
    const tail = `${digits(5)}${1 + Math.floor(random() * 9)}`
    replacements.push([account, `${account.slice(0, -6)}${tail}`])
  }
  let json = JSON.stringify(sample)
  for (const [from, to] of replacements) json = json.split(from).join(to)
  return JSON.parse(json) as T
}

/** Puts the simulated providers into exactly the state a scenario needs. */
export function useApplyScenario() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (s: Scenario) => {
      const chaos = await mockApi.post<ChaosConfig>('/admin/config', { ...ALL_OFF, ...s.switches })
      const merchant = await api.post<{ fail: boolean }>('/admin/merchant-service', { fail: s.failMerchant })
      return { chaos, merchant }
    },
    onSuccess: ({ chaos, merchant }) => {
      qc.setQueryData(qk.chaos, chaos)
      qc.setQueryData(qk.merchantService, merchant)
    },
  })
}
