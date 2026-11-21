import {
  allReviewReasons,
  APPLICATION_STATUSES,
  AUDIT_EVENTS,
  describeReason,
  EVENT_LABELS,
  humanize,
  STATUS_LABELS,
  verificationFailureReasons,
} from '@app/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReasonBadge, StatusBadge, STATUS_ICON } from './labels.tsx'

/* Paired with api/src/labels.test.ts, which proves the API only creates reasons from allReviewReasons(). */
describe('reason-label mapping covers every reason code in the API', () => {
  it.each(allReviewReasons())('%s has a label', (code) => {
    const r = describeReason(code)
    expect(r.known, `${code} has no label`).toBe(true)
    expect(r.label).not.toBe(humanize(code))
    expect(r.label.length).toBeGreaterThan(3)
    expect(r.description.length).toBeGreaterThan(10)
    expect(['success', 'warning', 'danger', 'info', 'neutral']).toContain(r.severity)
  })

  it('the brief examples read as expected', () => {
    expect(describeReason('PAN_OK_GST_FAILED').label).toBe('PAN verified, GST verification failed')
    expect(describeReason('DOC_CONFLICT').label).toBe("Document doesn't match the form")
    expect(describeReason('BANK_TIMEOUT').label).toBe('Bank account check timed out')
    expect(verificationFailureReasons()).toHaveLength(85)
  })

  it('unknown codes are reported as unknown (so the test above would catch a new API code)', () => {
    expect(describeReason('SOMETHING_NEW').known).toBe(false)
  })

  it('every state and audit event has a label; every state an icon', () => {
    for (const s of APPLICATION_STATUSES) {
      expect(STATUS_LABELS[s].label).toBeTruthy()
      expect(STATUS_ICON[s]).toBeTruthy()
    }
    for (const e of AUDIT_EVENTS) expect(EVENT_LABELS[e], e).toBeTruthy()
  })

  it('badges show words with the raw code in the tooltip (never color alone)', () => {
    render(
      <>
        <ReasonBadge reason="PAN_OK_GST_FAILED" />
        <StatusBadge status="IN_REVIEW" />
      </>,
    )
    expect(screen.getByText('PAN verified, GST verification failed')).toBeInTheDocument()
    // The badge text, and again (bold) at the start of its tooltip.
    expect(screen.getAllByText('In review')).toHaveLength(2)
    const tips = screen.getAllByRole('tooltip').map((t) => t.textContent)
    expect(tips.join(' ')).toContain('(PAN_OK_GST_FAILED)')
    expect(tips.join(' ')).toContain('IN_REVIEW')
  })
})
