import { DOCUMENT_TYPES, type ApplicationDetailDto, type DocumentType } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Card, ErrorBox, buttonClass, inputClass, PageHeader } from '../components/ui.tsx'
import { api } from '../lib/api.ts'

/** sample-data/*.json, bundled at build time. */
const SAMPLES = Object.fromEntries(
  Object.entries(import.meta.glob('../../../sample-data/*.json', { eager: true, import: 'default' })).map(([path, body]) => [
    path.split('/').pop()!,
    body as Record<string, unknown>,
  ]),
)

const FIELDS = [
  { key: 'merchant_name', label: 'Merchant name' },
  { key: 'pan', label: 'PAN' },
  { key: 'gst', label: 'GSTIN' },
  { key: 'bank_account', label: 'Bank account' },
  { key: 'ifsc', label: 'IFSC' },
] as const
type FieldKey = (typeof FIELDS)[number]['key']
const EMPTY: Record<FieldKey, string> = { merchant_name: '', pan: '', gst: '', bank_account: '', ifsc: '' }

/**
 * Merchant submission: form fields, structured documents as JSON, and/or
 * uploaded files. Without files it posts JSON; with files it posts
 * multipart (documents JSON as a text part, files under their document type).
 */
export function SubmitApplication() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [sample, setSample] = useState('')
  const [fields, setFields] = useState(EMPTY)
  const [docs, setDocs] = useState('[]')
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({})

  const loadSample = (name: string) => {
    setSample(name)
    const s = SAMPLES[name]
    if (!s) return
    setFields(Object.fromEntries(FIELDS.map(({ key }) => [key, String(s[key] ?? '')])) as Record<FieldKey, string>)
    setDocs(JSON.stringify(s.documents ?? [], null, 2))
  }

  const submit = useMutation({
    mutationFn: async () => {
      let documents: unknown
      try {
        documents = docs.trim() ? JSON.parse(docs) : []
      } catch {
        throw new Error('Documents must be valid JSON: an array of {"type", "payload"}')
      }
      const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== ''))
      const uploads = Object.entries(files).filter(([, f]) => f)
      if (uploads.length === 0) return api.post<ApplicationDetailDto>('/applications', { ...present, documents })
      const form = new FormData()
      for (const [k, v] of Object.entries(present)) form.append(k, v)
      // The API accepts one document per type: an uploaded file wins over a JSON one.
      const kept = Array.isArray(documents) ? documents.filter((d) => !files[(d as { type?: DocumentType }).type!]) : documents
      if (!Array.isArray(kept) || kept.length > 0) form.append('documents', JSON.stringify(kept))
      for (const [type, file] of uploads) form.append(type, file!)
      return api.postForm<ApplicationDetailDto>('/applications', form)
    },
    onSuccess: async (app) => {
      await qc.invalidateQueries()
      navigate(`/applications/${app.id}`)
    },
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit.mutate()
  }

  return (
    <>
    <PageHeader title="Submit application" subtitle="Send a new merchant application with its documents." />
    <Card
      title="Submit a merchant application"
      actions={
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Load sample
          <select className={`${inputClass} w-auto`} value={sample} onChange={(e) => loadSample(e.target.value)}>
            <option value="">—</option>
            {Object.keys(SAMPLES).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map(({ key, label }) => (
            <label key={key} className="text-xs text-slate-600">
              {label}
              {key === 'merchant_name' && ' *'}
              <input
                className={`${inputClass} font-mono`}
                value={fields[key]}
                required={key === 'merchant_name'}
                autoComplete="off"
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <label className="block text-xs text-slate-600">
          Documents (JSON array of {'{type, payload}'}; types {DOCUMENT_TYPES.join(', ')})
          <textarea className={`${inputClass} font-mono`} rows={12} value={docs} onChange={(e) => setDocs(e.target.value)} />
        </label>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-xs text-slate-600">Or upload files (PDF, PNG, JPEG; max 5 MB). An upload replaces the JSON document of the same type.</legend>
          {DOCUMENT_TYPES.map((type) => (
            <label key={type} className="text-xs text-slate-600">
              {type}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="block w-full text-xs"
                onChange={(e) => setFiles({ ...files, [type]: e.target.files?.[0] })}
              />
            </label>
          ))}
        </fieldset>
        <ErrorBox error={submit.error} />
        <button className={buttonClass.primary} disabled={submit.isPending}>
          {submit.isPending ? 'Submitting…' : 'Submit application'}
        </button>
      </form>
    </Card>
    </>
  )
}
