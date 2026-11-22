import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mockFetch, Providers } from '../test/render.tsx'
import { currentChecksOf } from '../lib/status.ts'
import { TaskCard } from './review.tsx'

const task = {
  id: 7,
  reason: 'PAN_OK_GST_FAILED',
  status: 'OPEN' as const,
  note: 'Verification failed: GST. PAN: passed, attempt 1; GST: failed (GSTIN_INACTIVE), attempt 1; BANK: pending, attempt 1; RISK: pending, attempt 1',
  resolution: null,
  resolution_note: null,
  related_application_id: null,
  created_at: new Date().toISOString(),
}
const NOW = [
  { kind: 'PAN', status: 'PASSED' },
  { kind: 'GST', status: 'FAILED' },
  { kind: 'BANK', status: 'PASSED' },
  { kind: 'RISK', status: 'PASSED' },
] as const

const card = (props: Partial<Parameters<typeof TaskCard>[0]> = {}) =>
  render(
    <Providers>
      <TaskCard task={task} applicationId="0b0e7a2c-1111-4222-8333-444455556666" merchantName="Shreyan Naskar" status="IN_REVIEW" checks="INCOMPLETE" currentChecks={[...NOW]} {...props} />
    </Providers>,
  )

describe('review task card: live check statuses next to the note from escalation', () => {
  it('shows each check as it stands now, and the stored note labelled "At time of escalation"', () => {
    mockFetch(() => undefined)
    card()
    const live = screen.getByRole('list', { name: 'Current verification status' })
    expect(within(live).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['PAN: Passed', 'GST: Failed', 'Bank account: Passed', 'Risk: Passed'])
    expect(screen.getByText('At time of escalation')).toBeInTheDocument()
    expect(screen.getByText(task.note)).toBeInTheDocument()
  })

  it('no live statuses before any check is requested, or on a resolved task', () => {
    mockFetch(() => undefined)
    const { unmount } = card({ currentChecks: NOW.map((c) => ({ kind: c.kind, status: null })) })
    expect(screen.queryByRole('list', { name: 'Current verification status' })).not.toBeInTheDocument()
    unmount()
    card({ task: { ...task, status: 'RESOLVED', resolution: 'REJECT', resolution_note: 'not for us' } })
    expect(screen.queryByRole('list', { name: 'Current verification status' })).not.toBeInTheDocument()
    expect(screen.getByText('At time of escalation')).toBeInTheDocument()
  })

  it('currentChecksOf reads the current row per check, ignoring replaced ones', () => {
    const v = (kind: string, status: string, is_current: boolean) => ({ kind, status, is_current })
    const app = { verifications: [v('PAN', 'PASSED', true), v('BANK', 'PASSED', false), v('BANK', 'PENDING', true)] } as never
    expect(currentChecksOf(app)).toEqual([
      { kind: 'PAN', status: 'PASSED' },
      { kind: 'GST', status: null },
      { kind: 'BANK', status: 'PENDING' },
      { kind: 'RISK', status: null },
    ])
  })
})
