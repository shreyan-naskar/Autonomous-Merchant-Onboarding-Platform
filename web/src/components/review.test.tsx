import type { ApplicationDetailDto, CheckProgress } from '@app/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockFetch, Providers } from '../test/render.tsx'
import { TaskCard } from './review.tsx'

const APP_ID = '0b0e7a2c-1111-4222-8333-444455556666'
const task = (reason: string) => ({
  id: 7,
  reason,
  status: 'OPEN' as const,
  note: null,
  resolution: null,
  resolution_note: null,
  related_application_id: null,
  created_at: new Date().toISOString(),
})
const card = (reason: string, checks: CheckProgress) =>
  render(
    <Providers>
      <TaskCard task={task(reason)} applicationId={APP_ID} merchantName="Shreyan Naskar" status="IN_REVIEW" checks={checks} />
    </Providers>,
  )

describe('review task actions follow where the checks stand', () => {
  it('documents not accepted yet (no check has run): "Accept documents and verify" first, no Approve, and why', async () => {
    mockFetch(() => undefined)
    card('LOW_CONFIDENCE', 'NOT_STARTED')
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['Accept documents and verify', 'Reject', 'Request information'])
    expect(screen.getByText('Approval unavailable: verification not started.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Accept documents and verify' }))
    expect(await screen.findByText(/The documents are accepted as read/)).toBeInTheDocument()
  })

  it('a failed check: re-run or decide, but no Approve', () => {
    mockFetch(() => undefined)
    card('PAN_OK_GST_FAILED', 'INCOMPLETE')
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reject', 'Request information', 'Re-run verification'])
    expect(screen.getByText('Approval unavailable: verification incomplete.')).toBeInTheDocument()
  })

  it('every check passed (e.g. high risk): Approve is offered and no hint is shown', () => {
    mockFetch(() => undefined)
    card('HIGH_RISK', 'ALL_PASSED')
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Approve', 'Reject', 'Request information', 'Re-run all verifications'])
    expect(screen.queryByText(/Approval unavailable/)).not.toBeInTheDocument()
  })
})

describe('a document task lets the reviewer look at the upload', () => {
  const doc = (id: number, type: 'PAN_CARD' | 'BANK_PROOF', file_name: string | null) => ({ id, type, file_name, payload: null, blur_score: null, created_at: new Date().toISOString() })
  const app = {
    id: APP_ID,
    documents: [doc(1, 'PAN_CARD', 'a.png'), doc(2, 'BANK_PROOF', 'b.pdf'), doc(3, 'BANK_PROOF', null)],
    extracted_fields: [{ id: 9, document_id: 2, field: 'ifsc', value: 'SBIN0O02117', confidence: 0.5, validation_status: 'low_confidence' }],
  } as unknown as ApplicationDetailDto

  it('the files the note names get a button; it opens the file next to the values read from it', async () => {
    mockFetch(() => undefined)
    render(
      <Providers>
        <TaskCard
          task={{ ...task('LOW_CONFIDENCE'), note: 'Low extraction confidence: BANK_PROOF.ifsc (invalid_format, confidence 0.5)' }}
          applicationId={APP_ID}
          merchantName="Shreyan Naskar"
          status="IN_REVIEW"
          checks="NOT_STARTED"
          showApplication={false}
          app={app}
        />
      </Providers>,
    )
    expect(screen.queryByRole('button', { name: 'PAN card' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Bank proof' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('iframe')).toHaveAttribute('src', `/api/applications/${APP_ID}/documents/2/file`)
    expect(screen.getByText('SBIN0O02117')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', `/api/applications/${APP_ID}/documents/2/file`)
  })
})
