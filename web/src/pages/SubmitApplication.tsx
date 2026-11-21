import {
  BANK_ACCOUNT_RE,
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  GSTIN_RE,
  IFSC_RE,
  PAN_RE,
  type ApplicationDetailDto,
  type DocumentType,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, FileJson, FlaskConical, Send, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { FileDrop } from '../components/FileDrop.tsx'
import { useToast } from '../components/toast.tsx'
import { Alert, Button, Card, ErrorAlert, Input, PageHeader, Textarea, cx } from '../components/ui.tsx'
import { api, fieldErrors } from '../lib/api.ts'

/** sample-data/*.json, bundled at build time. */
const SAMPLES: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../sample-data/*.json', { eager: true, import: 'default' })).map(([path, body]) => [
    path.split('/').pop()!,
    body as Record<string, unknown>,
  ]),
)

/** What each sample demonstrates, in plain words (unknown samples still load, without a description). */
const SAMPLE_INFO: Record<string, { title: string; text: string }> = {
  'happy.json': { title: 'Everything in order', text: 'Passes every check and gets a merchant ID in seconds.' },
  'gst-fail.json': { title: 'GST check fails', text: 'PAN passes, the GST provider rejects it: goes to review.' },
  'conflict.json': { title: "Document doesn't match", text: 'The PAN card is in another name: goes to review.' },
  'missing.json': { title: 'Missing document', text: 'No GST certificate: the merchant is asked for it.' },
  'high-risk.json': { title: 'High risk', text: 'Checks pass, risk score 85: a person must approve.' },
  'low-confidence.json': { title: 'Unclear value', text: 'The bank proof shows an invalid IFSC: goes to review.' },
  'ocr-pan.json': { title: 'Upload a PAN card', text: 'Add pan-sharp.png (or pan-blurry.png) as the PAN card in step 2.' },
}

const FIELDS = [
  { key: 'merchant_name', label: 'Business name', placeholder: 'Lakshmi Textiles Pvt Ltd' },
  { key: 'pan', label: 'PAN', placeholder: 'AABCL1234K', hint: '5 letters, 4 digits, 1 letter' },
  { key: 'gst', label: 'GSTIN', placeholder: '27AABCL1234K1Z5', hint: '15 characters; contains the PAN' },
  { key: 'bank_account', label: 'Bank account number', placeholder: '50100234567891', hint: '9 to 18 digits' },
  { key: 'ifsc', label: 'IFSC', placeholder: 'HDFC0001234', hint: '4 letters, 0, then 6 letters or digits' },
] as const
type FieldKey = (typeof FIELDS)[number]['key']
const EMPTY: Record<FieldKey, string> = { merchant_name: '', pan: '', gst: '', bank_account: '', ifsc: '' }

/** Same rules as the API (shared validators), checked as the merchant types. Empty optional fields are fine here. */
function validate(key: FieldKey, raw: string): string | null {
  const v = key === 'bank_account' ? raw.trim() : raw.trim().toUpperCase()
  if (key === 'merchant_name') return raw.trim().length >= 2 ? null : 'Enter the business name (at least 2 characters)'
  if (!v) return null
  const rule = { pan: PAN_RE, gst: GSTIN_RE, bank_account: BANK_ACCOUNT_RE, ifsc: IFSC_RE }[key]
  if (rule.test(v)) return null
  return {
    pan: 'PAN must be 5 letters, 4 digits, 1 letter',
    gst: 'GSTIN must be a 15-character GST number',
    bank_account: 'Account number must be 9 to 18 digits',
    ifsc: 'IFSC must be 4 letters, a 0, then 6 letters or digits',
  }[key]
}

interface StructuredDoc {
  type: DocumentType
  payload: Record<string, unknown>
}

const STEPS = ['Business details', 'Documents', 'Review and submit'] as const

/**
 * Submit a merchant application in three steps. Inline validation uses the
 * same format rules as the API; the API's own 400 details are mapped back
 * onto the fields. Files and structured (JSON) documents can be mixed; a file
 * replaces the structured document of the same type.
 */
export function SubmitApplication() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [sample, setSample] = useState<string | null>(null)
  const [fields, setFields] = useState(EMPTY)
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [structured, setStructured] = useState<StructuredDoc[]>([])
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({})
  const [advanced, setAdvanced] = useState('')
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})

  const loadSample = (name: string) => {
    const s = SAMPLES[name]
    if (!s) return
    setSample(name)
    setFields(Object.fromEntries(FIELDS.map(({ key }) => [key, String(s[key] ?? '')])) as Record<FieldKey, string>)
    setStructured(((s.documents as StructuredDoc[] | undefined) ?? []).map((d) => ({ type: d.type, payload: d.payload })))
    setFiles({})
    setTouched({})
    setServerErrors({})
    toast.push({ tone: 'info', title: `Loaded “${SAMPLE_INFO[name]?.title ?? name}”`, message: 'Review the details, then continue.' })
  }

  const errorOf = (k: FieldKey) => serverErrors[k] ?? (touched[k] ? validate(k, fields[k]) : null)
  const step1Valid = FIELDS.every(({ key }) => validate(key, fields[key]) === null)

  const submit = useMutation({
    mutationFn: async () => {
      let extra: StructuredDoc[] = []
      if (advanced.trim()) {
        try {
          extra = JSON.parse(advanced) as StructuredDoc[]
        } catch {
          throw new Error('Advanced documents must be valid JSON: an array of {"type", "payload"}')
        }
      }
      const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]))
      // One document per type: a file wins over structured data of the same type.
      const docs = [...structured, ...extra].filter((d) => !files[d.type])
      const uploads = Object.entries(files).filter(([, f]) => f)
      if (uploads.length === 0) return api.post<ApplicationDetailDto>('/applications', { ...present, documents: docs })
      const form = new FormData()
      for (const [k, v] of Object.entries(present)) form.append(k, v)
      if (docs.length) form.append('documents', JSON.stringify(docs))
      for (const [type, file] of uploads) form.append(type, file!)
      return api.postForm<ApplicationDetailDto>('/applications', form)
    },
    onSuccess: async (app) => {
      toast.push({ tone: 'success', title: 'Application submitted', message: `${app.merchant_name} is being processed.` })
      await qc.invalidateQueries()
      navigate(`/applications/${app.id}`)
    },
    onError: (err) => {
      const fe = fieldErrors(err)
      setServerErrors(fe)
      if (FIELDS.some(({ key }) => fe[key])) setStep(0)
    },
  })

  const next = (e?: FormEvent) => {
    e?.preventDefault()
    if (step === 0) {
      setTouched(Object.fromEntries(FIELDS.map(({ key }) => [key, true])))
      if (!step1Valid) return
    }
    if (step < 2) setStep(step + 1)
    else submit.mutate()
  }

  const docSummary = DOCUMENT_TYPES.map((t) => ({
    type: t,
    source: files[t] ? `File: ${files[t]!.name}` : structured.some((d) => d.type === t) ? 'Structured data' : null,
  }))

  return (
    <>
      <PageHeader title="Submit application" subtitle="Send a new merchant application with its documents." />

      <nav aria-label="Steps" className="mb-5">
        <ol className="flex flex-wrap items-center gap-2">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-6 bg-neutral-300" />}
              <button
                type="button"
                onClick={() => (i < step || (i === 1 && step1Valid) || (i === 2 && step1Valid) ? setStep(i) : undefined)}
                aria-current={i === step ? 'step' : undefined}
                className={cx(
                  'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium',
                  i === step ? 'bg-accent-700 text-white' : i < step ? 'bg-accent-50 text-accent-800 hover:bg-accent-100' : 'bg-white text-neutral-500 ring-1 ring-neutral-200',
                )}
              >
                <span className={cx('flex size-5 items-center justify-center rounded-full text-2xs', i === step ? 'bg-white/20' : i < step ? 'bg-accent-700 text-white' : 'bg-neutral-100')}>
                  {i < step ? <Check aria-hidden className="size-3" /> : i + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <form onSubmit={next} noValidate className="space-y-5">
        {step === 0 && (
          <>
            <Card title="Start from a sample" subtitle="Each sample shows a different path through onboarding. You can edit it before submitting.">
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {Object.keys(SAMPLES)
                  .sort((a, b) => Object.keys(SAMPLE_INFO).indexOf(a) - Object.keys(SAMPLE_INFO).indexOf(b))
                  .map((name) => {
                    const info = SAMPLE_INFO[name]
                    const active = sample === name
                    return (
                      <li key={name}>
                        <button
                          type="button"
                          onClick={() => loadSample(name)}
                          aria-pressed={active}
                          className={cx(
                            'h-full w-full rounded-card border p-3 text-left transition-colors',
                            active ? 'border-accent-600 bg-accent-50 ring-1 ring-accent-600' : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
                            <FlaskConical aria-hidden className="size-3.5 text-accent-700" />
                            {info?.title ?? name}
                          </span>
                          {info && <span className="mt-1 block text-xs text-neutral-600">{info.text}</span>}
                          <span className="mt-1 block font-mono text-2xs text-neutral-400">{name}</span>
                        </button>
                      </li>
                    )
                  })}
              </ul>
            </Card>
            <Card title="Business details" subtitle="What the merchant declares. Documents are checked against these values.">
              <div className="grid gap-4 sm:grid-cols-2">
                {FIELDS.map(({ key, label, placeholder, ...rest }) => (
                  <Input
                    key={key}
                    label={label}
                    required={key === 'merchant_name'}
                    placeholder={placeholder}
                    hint={'hint' in rest ? rest.hint : undefined}
                    error={errorOf(key)}
                    value={fields[key]}
                    autoComplete="off"
                    className={key === 'merchant_name' ? undefined : 'font-mono uppercase placeholder:normal-case'}
                    onChange={(e) => {
                      setFields({ ...fields, [key]: e.target.value })
                      if (serverErrors[key]) setServerErrors({ ...serverErrors, [key]: '' })
                    }}
                    onBlur={() => setTouched({ ...touched, [key]: true })}
                  />
                ))}
              </div>
            </Card>
          </>
        )}

        {step === 1 && (
          <Card title="Documents" subtitle="PAN card, GST certificate and bank proof. Upload files (PDF, PNG, JPEG) or use the sample's structured data.">
            <div className="grid gap-4 lg:grid-cols-3">
              {DOCUMENT_TYPES.map((t) => {
                const s = structured.find((d) => d.type === t)
                return (
                  <div key={t} className="space-y-2">
                    <FileDrop label={DOCUMENT_LABELS[t]} hint="PDF, PNG or JPEG, up to 5 MB" file={files[t]} onChange={(f) => setFiles({ ...files, [t]: f })} />
                    {s && !files[t] && (
                      <div className="flex items-center gap-2 rounded-control bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-200">
                        <FileJson aria-hidden className="size-4 text-neutral-500" />
                        <span className="flex-1">Structured data from the sample</span>
                        <button
                          type="button"
                          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200"
                          aria-label={`Remove structured ${DOCUMENT_LABELS[t]}`}
                          onClick={() => setStructured(structured.filter((d) => d.type !== t))}
                        >
                          <X aria-hidden className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <details className="mt-5 text-sm">
              <summary className="cursor-pointer font-medium text-neutral-700 select-none">Advanced: add structured documents as JSON</summary>
              <div className="mt-2">
                <Textarea
                  label="Documents (JSON array of {type, payload})"
                  className="font-mono text-xs"
                  rows={6}
                  value={advanced}
                  onChange={(e) => setAdvanced(e.target.value)}
                  placeholder='[{"type": "GST_CERT", "payload": {"gstin": "…", "legal_name": "…"}}]'
                />
              </div>
            </details>
          </Card>
        )}

        {step === 2 && (
          <Card title="Review and submit">
            <div className="grid gap-6 md:grid-cols-2">
              <dl className="space-y-2 text-sm">
                {FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                    <dt className="text-neutral-500">{label}</dt>
                    <dd className={cx('text-right', key !== 'merchant_name' && 'font-mono', !fields[key] && 'text-neutral-400')}>{fields[key] || 'not given'}</dd>
                  </div>
                ))}
              </dl>
              <ul className="space-y-2 text-sm">
                {docSummary.map((d) => (
                  <li key={d.type} className="flex items-center justify-between gap-3 border-b border-neutral-100 pb-2">
                    <span className="text-neutral-500">{DOCUMENT_LABELS[d.type]}</span>
                    <span className={cx('truncate', d.source ? 'text-neutral-900' : 'text-warning-700')}>{d.source ?? 'missing (the merchant will be asked)'}</span>
                  </li>
                ))}
              </ul>
            </div>
            {submit.error && !Object.keys(fieldErrors(submit.error)).length && (
              <div className="mt-4">
                <ErrorAlert error={submit.error} />
              </div>
            )}
            {Object.keys(serverErrors).some((k) => k.startsWith('documents')) && (
              <div className="mt-4">
                <Alert tone="danger" title="A document was not accepted">
                  {Object.entries(serverErrors)
                    .filter(([k]) => k.startsWith('documents'))
                    .map(([k, m]) => `${k}: ${m}`)
                    .join(' · ')}
                </Alert>
              </div>
            )}
          </Card>
        )}

        <div className="flex items-center justify-between">
          <Button icon={ArrowLeft} onClick={() => setStep(step - 1)} disabled={step === 0}>
            Back
          </Button>
          {step < 2 ? (
            <Button type="submit" variant="primary">
              Continue <ArrowRight aria-hidden className="size-4" />
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon={Send} loading={submit.isPending}>
              Submit application
            </Button>
          )}
        </div>
      </form>
    </>
  )
}
