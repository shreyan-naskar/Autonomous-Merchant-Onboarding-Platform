import type { ApplicationDetailDto } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.ts'
import { ErrorBox, buttonClass, inputClass } from './ui.tsx'

/** Items listed by the latest INFO_REQUIRED audit entry (labels like `document.GST_CERT`). */
function latestMissing(app: ApplicationDetailDto): string[] {
  const entry = [...app.audit_log].reverse().find((a) => a.event === 'INFO_REQUIRED')
  const missing = (entry?.detail as { missing?: unknown } | null)?.missing
  return Array.isArray(missing) ? missing.map(String) : []
}

const EXAMPLE = '[{"type": "GST_CERT", "payload": {"gstin": "…", "legal_name": "…"}}]'

/**
 * Shown while the application is in NEEDS_INFO: what is missing, and a way
 * for the merchant to supply documents (PATCH documents -> re-extraction).
 */
export function MissingInfoPanel({ app }: { app: ApplicationDetailDto }) {
  const qc = useQueryClient()
  const [docs, setDocs] = useState('')
  const supply = useMutation({
    mutationFn: async () => {
      let documents: unknown
      try {
        documents = JSON.parse(docs)
      } catch {
        throw new Error('Documents must be valid JSON (an array of {type, payload})')
      }
      return api.patch(`/applications/${app.id}`, { documents })
    },
    onSuccess: () => qc.invalidateQueries(),
  })
  const missing = latestMissing(app)
  const operatorRequest = [...app.audit_log].reverse().find((a) => a.event === 'OPERATOR_REQUESTED_INFO')
  const note = (operatorRequest?.detail as { note?: string } | null)?.note

  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">Information needed from the merchant</h2>
      {missing.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-900">
          {missing.map((m) => (
            <li key={m} className="font-mono text-xs">
              {m}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-sm text-amber-900">Operator: “{note}”</p>}
      <label className="block text-xs text-amber-900">
        Supply documents (JSON)
        <textarea className={`${inputClass} font-mono`} rows={4} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder={EXAMPLE} />
      </label>
      <ErrorBox error={supply.error} />
      <button className={buttonClass.primary} disabled={!docs.trim() || supply.isPending} onClick={() => supply.mutate()}>
        Submit documents
      </button>
    </div>
  )
}
