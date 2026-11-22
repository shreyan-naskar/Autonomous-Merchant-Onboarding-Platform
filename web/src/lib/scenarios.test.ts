import { GSTIN_RE, PAN_RE } from '@app/shared'
import { describe, expect, it } from 'vitest'
import gstFail from '../../../sample-data/gst-fail.json'
import conflict from '../../../sample-data/conflict.json'
import { withFreshIdentifiers } from './scenarios.ts'

describe('withFreshIdentifiers', () => {
  it('changes PAN, GSTIN and account everywhere, keeping formats and the PAN inside the GSTIN', () => {
    const out = withFreshIdentifiers(conflict, () => 0.42)
    expect(out.pan).not.toBe(conflict.pan)
    expect(out.pan).toMatch(PAN_RE)
    expect(out.gst).toMatch(GSTIN_RE)
    expect(out.gst.slice(2, 12)).toBe(out.pan)
    expect(out.bank_account).not.toBe(conflict.bank_account)
    expect(out.bank_account).toHaveLength(conflict.bank_account.length)
    expect(out.bank_account.endsWith('0000')).toBe(false)
    const docs = out.documents.map((d) => d.payload)
    expect(docs[0]!.pan).toBe(out.pan)
    expect(docs[0]!.name).toBe('Ramesh Electricals Pvt Ltd')
    expect(docs[1]!.gstin).toBe(out.gst)
    expect(docs[2]!.account_number).toBe(out.bank_account)
  })

  it('keeps the GST suffix the mock provider rejects', () => {
    expect(withFreshIdentifiers(gstFail).gst.endsWith('Z9')).toBe(true)
  })

  it('never produces an account ending in 0000 (the mock bank never answers those)', () => {
    expect(withFreshIdentifiers(conflict, () => 0).bank_account.endsWith('0000')).toBe(false)
  })
})
