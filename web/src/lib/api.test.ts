import { describe, expect, it } from 'vitest'
import { ApiError, fieldErrors, friendlyError } from './api.ts'

describe('central API error handling', () => {
  it('classifies errors by status', () => {
    expect(new ApiError('x', 0, 'NETWORK').kind).toBe('network')
    expect(new ApiError('x', 400, 'VALIDATION_FAILED').kind).toBe('validation')
    expect(new ApiError('x', 404, 'NOT_FOUND').kind).toBe('not_found')
    expect(new ApiError('x', 409, 'GUARD_FAILED').kind).toBe('conflict')
    expect(new ApiError('x', 502).kind).toBe('server')
  })

  it('maps 400 Zod details onto form fields', () => {
    const err = new ApiError('Request validation failed', 400, 'VALIDATION_FAILED', [
      { path: 'pan', code: 'invalid_format', message: 'PAN must be 5 letters, 4 digits, 1 letter' },
      { path: 'documents.0.type', code: 'invalid_value', message: 'Invalid option' },
    ])
    expect(fieldErrors(err)).toEqual({ pan: 'PAN must be 5 letters, 4 digits, 1 letter', 'documents.0.type': 'Invalid option' })
    expect(fieldErrors(new Error('x'))).toEqual({})
  })

  it('turns the approval guard 409 into plain words, keeping the raw text for a tooltip', () => {
    const raw = 'Cannot approve: BANK is pending for bank version 2. All of PAN, GST, BANK, RISK must pass first.'
    const f = friendlyError(new ApiError(raw, 409, 'GUARD_FAILED', { missing: ['BANK'], checks: { BANK: 'PENDING' }, bankVersion: 2 }))
    expect(f.title).toBe('Approval unavailable: bank verification (new bank details) pending.')
    expect(f.message).toBe('All four verifications (PAN, GST, bank account, risk) must pass.')
    expect(f.raw).toBe(raw)
  })

  it('network and server errors get friendly titles', () => {
    expect(friendlyError(new ApiError('x', 0, 'NETWORK')).title).toBe('Service unavailable')
    expect(friendlyError(new ApiError('x', 500)).title).toBe('Server error')
  })
})
