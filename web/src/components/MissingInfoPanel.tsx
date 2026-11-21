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
import { FileQuestion, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, fieldErrors } from '../lib/api.ts'
import { FileDrop } from './FileDrop.tsx'
import { useToast } from './toast.tsx'
import { Button, ErrorAlert, Input, Textarea } from './ui.tsx'

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

/**
 * Shown while the application is in NEEDS_INFO: what to supply, in plain
 * language, with an input for each requested form field and an upload for
 * each requested document. Everything else is under "Other changes".
 * Sends one multipart PATCH; any real change moves the application back to
 * extraction (NEEDS_INFO -> EXTRACTING).
 */
export function MissingInfoPanel({ app }: { app: ApplicationDetailDto }) {
  const qc = useQueryClient()
  const toast = useToast()
  const fix = whatToFix(app)
  const [fields, setFields] = useState<Partial<Record<MerchantFormField, string>>>({})
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({})
  const [docs, setDocs] = useState('')

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
      toast.push({ tone: 'success', title: 'Information sent', message: 'The documents are being read again.' })
      return qc.invalidateQueries()
    },
  })
  const errs = fieldErrors(send.error)

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
      <Input
        key={f}
        label={FORM_FIELD_LABELS[f]}
        hint={cur ? `Now: ${cur}` : undefined}
        error={errs[f]}
        className="font-mono"
        value={fields[f] ?? ''}
        autoComplete="off"
        onChange={(e) => setFields({ ...fields, [f]: e.target.value })}
      />
    )
  }
  const fileInput = (t: DocumentType) => {
    const existing = app.documents.find((d) => d.type === t)
    return (
      <FileDrop
        key={t}
        label={DOCUMENT_LABELS[t]}
        hint={existing ? `Now: ${existing.file_name ?? 'structured data'}` : 'PDF, PNG or JPEG, up to 5 MB'}
        file={files[t]}
        onChange={(file) => setFiles({ ...files, [t]: file })}
      />
    )
  }

  return (
    <form
      id="missing-info"
      onSubmit={onSubmit}
      className="scroll-mt-24 space-y-4 rounded-card border border-warning-200 bg-warning-50/60 p-4 shadow-card"
      aria-labelledby="missing-info-title"
    >
      <div className="flex items-start gap-3">
        <span className="rounded-md bg-warning-100 p-2 text-warning-800">
          <FileQuestion aria-hidden className="size-5" />
        </span>
        <div>
          <h2 id="missing-info-title" className="text-sm font-semibold text-warning-800">
            Information needed from the merchant
          </h2>
          {fix.requests.length > 0 && (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-warning-800">
              {fix.requests.map((r, i) => (
                <li key={i}>
                  {r.message}
                  {r.operatorNote && <span className="italic"> “{r.operatorNote}”</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {(fix.formFields.length > 0 || fix.documents.length > 0) && !fix.byOperator && (
        <div className="grid gap-3 rounded-card bg-white p-4 ring-1 ring-warning-200 sm:grid-cols-2">
          {fix.formFields.map(fieldInput)}
          {fix.documents.map(fileInput)}
        </div>
      )}

      <details className="rounded-card bg-white p-3 text-sm ring-1 ring-neutral-200" open={fix.byOperator}>
        <summary className="cursor-pointer font-medium text-neutral-700 select-none">{fix.byOperator ? 'Fields and documents' : 'Other changes'}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(fix.byOperator ? MERCHANT_FORM_FIELDS : otherFields).map(fieldInput)}
          {(fix.byOperator ? DOCUMENT_TYPES : otherDocs).map(fileInput)}
        </div>
        <div className="mt-3">
          <Textarea label="Documents as JSON (advanced)" className="font-mono text-xs" rows={3} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder={EXAMPLE} />
        </div>
      </details>

      {send.error && !Object.keys(errs).length && <ErrorAlert error={send.error} />}
      <Button type="submit" variant="primary" icon={Send} disabled={!hasInput} loading={send.isPending}>
        Send information
      </Button>
    </form>
  )
}
