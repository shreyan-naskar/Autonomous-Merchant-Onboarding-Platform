import {
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  FORM_FIELD_LABELS,
  InfoRequestDetailSchema,
  MERCHANT_FORM_FIELDS,
  type ApplicationDetailDto,
  type DocumentType,
  type InfoRequestDetail,
  type MerchantFormField,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api.ts'
import { ErrorBox, buttonClass, inputClass } from './ui.tsx'

type Request = { message: string; operatorNote?: string }

interface WhatToFix {
  /** Plain-language items to show. */
  requests: Request[]
  formFields: MerchantFormField[]
  documents: DocumentType[]
  /** Operator asked (REQUEST_INFO): no system list, so everything is offered. */
  byOperator: boolean
}

/**
 * What the merchant is asked to supply: the detail of the audit entry that moved
 * the application into NEEDS_INFO. System requests carry messages and the
 * fields / documents to offer (InfoRequestDetail); an operator's request
 * carries a note, and then every field and document is offered.
 */
function whatToFix(app: ApplicationDetailDto): WhatToFix {
  const entry = [...app.audit_log].reverse().find((a) => a.to_state === 'NEEDS_INFO')
  if (entry?.event === 'OPERATOR_REQUESTED_INFO') {
    const note = (entry.detail as { note?: string } | null)?.note
    return {
      requests: [{ message: 'A reviewer asked for more information.', operatorNote: note }],
      formFields: [...MERCHANT_FORM_FIELDS],
      documents: [...DOCUMENT_TYPES],
      byOperator: true,
    }
  }
  const parsed = InfoRequestDetailSchema.safeParse(entry?.detail)
  if (parsed.success) {
    const d: InfoRequestDetail = parsed.data
    return {
      requests: d.requests.map((r) => ({ message: r.message })),
      formFields: d.form_fields,
      documents: d.documents,
      byOperator: false,
    }
  }
  // Older entries only list `missing` labels (form.pan, document.GST_CERT, PAN_CARD.pan).
  const missing = ((entry?.detail as { missing?: unknown } | null)?.missing as string[] | undefined) ?? []
  return {
    requests: missing.map((m) => ({ message: m })),
    formFields: missing.filter((m) => m.startsWith('form.')).map((m) => m.slice(5) as MerchantFormField),
    // document.GST_CERT -> GST_CERT; PAN_CARD.pan -> PAN_CARD
    documents: [
      ...new Set(
        missing.flatMap((m) => (m.startsWith('form.') ? [] : [(m.startsWith('document.') ? m.slice(9) : m.split('.')[0]) as DocumentType])),
      ),
    ],
    byOperator: false,
  }
}

/** Current value hint for an input (the API masks PAN / GSTIN / account). */
function current(app: ApplicationDetailDto, f: MerchantFormField): string | null {
  const v = { merchant_name: app.merchant_name, pan: app.pan, gst: app.gst, bank_account: app.bank_account, ifsc: app.ifsc }[f]
  return v ?? null
}

const EXAMPLE = '[{"type": "GST_CERT", "payload": {"gstin": "…", "legal_name": "…"}}]'
const ACCEPT = 'application/pdf,image/png,image/jpeg'

/**
 * Shown while the application is in NEEDS_INFO: what to supply, in plain
 * language, with an input for each requested form field and an upload for
 * each requested document. Everything else is under "Other changes".
 * Sends one multipart PATCH; any real change moves the application back to
 * extraction (NEEDS_INFO -> EXTRACTING).
 */
export function MissingInfoPanel({ app }: { app: ApplicationDetailDto }) {
  const qc = useQueryClient()
  const fix = whatToFix(app)
  const [fields, setFields] = useState<Partial<Record<MerchantFormField, string>>>({})
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({})
  const [docs, setDocs] = useState('')
  const [formKey, setFormKey] = useState(0) // remount file inputs after a successful send

  const send = useMutation({
    mutationFn: async () => {
      const form = new FormData()
      for (const [k, v] of Object.entries(fields)) if (v && v.trim()) form.append(k, v.trim())
      if (docs.trim()) {
        let parsed: unknown
        try {
          parsed = JSON.parse(docs)
        } catch {
          throw new Error('Documents must be valid JSON (an array of {type, payload})')
        }
        // An uploaded file wins over a JSON document of the same type.
        const kept = Array.isArray(parsed) ? parsed.filter((d) => !files[(d as { type?: DocumentType }).type!]) : parsed
        form.append('documents', JSON.stringify(kept))
      }
      for (const [type, file] of Object.entries(files)) if (file) form.append(type, file)
      return api.patchForm<ApplicationDetailDto>(`/applications/${app.id}`, form)
    },
    onSuccess: () => {
      setFields({})
      setFiles({})
      setDocs('')
      setFormKey((k) => k + 1)
      return qc.invalidateQueries()
    },
  })

  const otherFields = MERCHANT_FORM_FIELDS.filter((f) => !fix.formFields.includes(f))
  const otherDocs = DOCUMENT_TYPES.filter((t) => !fix.documents.includes(t))
  const hasInput = Object.values(fields).some((v) => v && v.trim()) || Object.values(files).some(Boolean) || docs.trim() !== ''
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    send.mutate()
  }

  const fieldInput = (f: MerchantFormField) => {
    const cur = current(app, f)
    return (
      <label key={f} className="block text-xs text-amber-900">
        {FORM_FIELD_LABELS[f]}
        {cur && <span className="ml-1 font-mono text-amber-700">(now: {cur})</span>}
        <input
          className={`${inputClass} font-mono`}
          value={fields[f] ?? ''}
          autoComplete="off"
          onChange={(e) => setFields({ ...fields, [f]: e.target.value })}
        />
      </label>
    )
  }
  const fileInput = (t: DocumentType) => {
    const existing = app.documents.find((d) => d.type === t)
    return (
      <label key={t} className="block text-xs text-amber-900">
        {DOCUMENT_LABELS[t]}
        {existing && <span className="ml-1 text-amber-700">(now: {existing.file_name ?? 'JSON document'})</span>}
        <input
          type="file"
          accept={ACCEPT}
          className="mt-1 block w-full text-xs"
          onChange={(e) => setFiles({ ...files, [t]: e.target.files?.[0] })}
        />
      </label>
    )
  }

  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div>
        <h2 className="text-sm font-semibold text-amber-900">Information needed from the merchant</h2>
      </div>

      {fix.requests.length > 0 && (
        <ul className="list-inside list-disc space-y-1 text-sm text-amber-900">
          {fix.requests.map((r, i) => (
            <li key={i}>
              {r.message}
              {r.operatorNote && <span className="italic"> “{r.operatorNote}”</span>}
            </li>
          ))}
        </ul>
      )}

      {(fix.formFields.length > 0 || fix.documents.length > 0) && !fix.byOperator && (
        <div className="grid gap-3 sm:grid-cols-2">
          {fix.formFields.map(fieldInput)}
          {fix.documents.map(fileInput)}
        </div>
      )}

      <details className="text-xs text-amber-900" open={fix.byOperator}>
        <summary className="cursor-pointer select-none">{fix.byOperator ? 'Fields and documents' : 'Other changes'}</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {(fix.byOperator ? MERCHANT_FORM_FIELDS : otherFields).map(fieldInput)}
          {(fix.byOperator ? DOCUMENT_TYPES : otherDocs).map(fileInput)}
        </div>
        <label className="mt-3 block">
          Documents as JSON (advanced)
          <textarea className={`${inputClass} font-mono`} rows={3} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder={EXAMPLE} />
        </label>
      </details>

      <p className="text-xs text-amber-800">Files: PDF, PNG or JPEG, up to 5 MB. A new file replaces the current document of that type.</p>
      <ErrorBox error={send.error} />
      <button type="submit" className={buttonClass.primary} disabled={!hasInput || send.isPending}>
        {send.isPending ? 'Sending…' : 'Send information'}
      </button>
    </form>
  )
}
