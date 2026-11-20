import type { ApplicationDetailDto } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api.ts'
import { ErrorBox, buttonClass, inputClass } from './ui.tsx'

/**
 * Merchant bank change: PATCH bank_account / ifsc. The API decides what
 * happens (bank_version bump, BANK re-verification, 409 once approved).
 */
export function BankChangeForm({ app }: { app: ApplicationDetailDto }) {
  const qc = useQueryClient()
  const [account, setAccount] = useState('')
  const [ifsc, setIfsc] = useState('')
  const change = useMutation({
    mutationFn: () =>
      api.patch<ApplicationDetailDto>(`/applications/${app.id}`, {
        ...(account ? { bank_account: account } : {}),
        ...(ifsc ? { ifsc } : {}),
      }),
    onSuccess: () => {
      setAccount('')
      setIfsc('')
      return qc.invalidateQueries()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    change.mutate()
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="text-xs text-slate-500">
        Current: <span className="font-mono">{app.bank_account ?? '—'}</span> / <span className="font-mono">{app.ifsc ?? '—'}</span>, bank
        version {app.bank_version}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          New account number
          <input className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="60200111122223" autoComplete="off" />
        </label>
        <label className="text-xs">
          New IFSC
          <input className={inputClass} value={ifsc} onChange={(e) => setIfsc(e.target.value)} placeholder="ICIC0009999" autoComplete="off" />
        </label>
      </div>
      <ErrorBox error={change.error} />
      {change.isSuccess && <p className="text-xs text-green-700">Bank details updated; status is now {change.data.status}.</p>}
      <button className={buttonClass.secondary} disabled={change.isPending || (!account && !ifsc)}>
        Change bank details
      </button>
    </form>
  )
}
