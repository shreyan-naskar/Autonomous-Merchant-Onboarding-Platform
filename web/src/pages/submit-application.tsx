import {
  BANK_ACCOUNT_RE,
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  GSTIN_RE,
  IFSC_RE,
  PAN_RE,
  UPLOAD_FORMATS_LABEL,
  type ApplicationDetailDto,
  type DocumentType,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, CircleCheck, FileJson, List, Plus, Send, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { FileDrop } from '../components/file-drop.tsx'
import { Alert, Button, Card, CopyButton, ErrorAlert, Input, PageHeader, Textarea } from '../components/ui.tsx'
import { SCENARIOS, withFreshIdentifiers, type Scenario } from '../lib/scenarios.ts'
import type { ScenarioRouteState } from './scenarios.tsx'
import { cx } from '../lib/tone.ts'
import { api, fieldErrors } from '../lib/api.ts'
import { SCENARIOS as SC, SUBMIT as C } from '../copy.ts'

const FIELDS = [
  { key: 'merchant_name', ...C.fields.merchant_name },
  { key: 'pan', ...C.fields.pan },
  { key: 'gst', ...C.fields.gst },
  { key: 'bank_account', ...C.fields.bank_account },
  { key: 'ifsc', ...C.fields.ifsc },
] as const
type FieldKey = (typeof FIELDS)[number]['key']
const EMPTY: Record<FieldKey, string> = { merchant_name: '', pan: '', gst: '', bank_account: '', ifsc: '' }

/** The API's own format rules; empty optional fields are fine at this point. */
function validate(key: FieldKey, raw: string): string | null {
  const v = key === 'bank_account' ? raw.trim() : raw.trim().toUpperCase()
  if (key === 'merchant_name') return raw.trim().length >= 2 ? null : C.invalid.merchant_name
  if (!v) return null
  const rule = { pan: PAN_RE, gst: GSTIN_RE, bank_account: BANK_ACCOUNT_RE, ifsc: IFSC_RE }[key]
  if (rule.test(v)) return null
  return C.invalid[key]
}

interface StructuredDoc {
  type: DocumentType
  payload: Record<string, unknown>
}

/** A scenario's sample under fresh identifiers, as the form's starting values. */
function scenarioStart(scenario: Scenario | null): { fields: Record<FieldKey, string>; structured: StructuredDoc[] } {
  if (!scenario) return { fields: EMPTY, structured: [] }
  const s = withFreshIdentifiers(scenario.sample)
  return {
    fields: Object.fromEntries(FIELDS.map(({ key }) => [key, s[key]])) as Record<FieldKey, string>,
    structured: s.documents.map((d) => ({ type: d.type, payload: d.payload })),
  }
}

const STEPS = C.steps

export function SubmitApplication() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const location = useLocation()
  // Set by the Scenarios page; the form starts pre-filled with that scenario's sample.
  const [scenario, setScenario] = useState<Scenario | null>(
    () => SCENARIOS.find((s) => s.id === (location.state as ScenarioRouteState | null)?.scenario) ?? null,
  )
  const [start] = useState(() => scenarioStart(scenario))
  const [fields, setFields] = useState(start.fields)
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [structured, setStructured] = useState<StructuredDoc[]>(start.structured)
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({})
  const [advanced, setAdvanced] = useState('')
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  // The merchant gets a confirmation, not the operator's view of the application.
  const [submitted, setSubmitted] = useState<ApplicationDetailDto | null>(null)

  const errorOf = (k: FieldKey) => serverErrors[k] ?? (touched[k] ? validate(k, fields[k]) : null)
  const step1Valid = FIELDS.every(({ key }) => validate(key, fields[key]) === null)

  const submit = useMutation({
    mutationFn: async () => {
      let extra: StructuredDoc[] = []
      if (advanced.trim()) {
        try {
          extra = JSON.parse(advanced) as StructuredDoc[]
        } catch {
          throw new Error(C.advancedError)
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
      setSubmitted(app)
      window.scrollTo?.({ top: 0 })
      await qc.invalidateQueries()
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

  const startOver = () => {
    setSubmitted(null)
    setStep(0)
    setScenario(null)
    setFields(EMPTY)
    setTouched({})
    setStructured([])
    setFiles({})
    setAdvanced('')
    setServerErrors({})
    submit.reset()
  }

  if (submitted) {
    return (
      <>
        <PageHeader title={C.title} subtitle={C.subtitle} />
        <Card>
          <div role="status" className="flex flex-col items-center px-6 py-10 text-center">
            <span className="rounded-full bg-success-50 p-3 text-success-700">
              <CircleCheck aria-hidden className="size-7" />
            </span>
            <h2 className="mt-4 text-lg font-semibold text-neutral-900">{C.doneTitle}</h2>
            <p className="mt-1 max-w-md text-sm text-neutral-600">
              {C.doneTextPrefix} <span className="font-medium text-neutral-900">{submitted.merchant_name}</span>. {C.doneTextSuffix}
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-control bg-neutral-50 px-3 py-2 text-sm ring-1 ring-neutral-200">
              <span className="text-neutral-500">{C.reference}</span>
              <span className="font-mono text-neutral-900">{submitted.id}</span>
              <CopyButton value={submitted.id} label={C.copyReference} />
            </div>
            <p className="mt-3 text-xs text-neutral-500">{C.findIt}</p>
            {scenario && (
              <div className="mt-5 w-full max-w-xl text-left">
                <Alert tone="info" title={scenario.caption}>
                  <ScenarioMeta id={scenario.id} />
                </Alert>
              </div>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button variant="primary" icon={Plus} onClick={startOver}>
                {C.another}
              </Button>
              <Button icon={List} onClick={() => navigate('/')}>
                {C.toList}
              </Button>
            </div>
          </div>
        </Card>
      </>
    )
  }

  const docSummary = DOCUMENT_TYPES.map((t) => ({
    type: t,
    source: files[t] ? C.fileSource(files[t]!.name) : structured.some((d) => d.type === t) ? C.structuredSource : null,
  }))

  return (
    <>
      <PageHeader title={C.title} subtitle={C.subtitle} />

      <nav aria-label={C.stepsLabel} className="mb-5">
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
                  i === step ? 'bg-accent-700 text-white' : i < step ? 'bg-success-50 text-success-800 hover:bg-success-100' : 'bg-white text-neutral-500 ring-1 ring-neutral-200',
                )}
              >
                <span className={cx('flex size-5 items-center justify-center rounded-full text-2xs', i === step ? 'bg-highlight-400 text-accent-700' : i < step ? 'bg-success-700 text-white' : 'bg-neutral-100')}>
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
            {scenario && (
              <Alert
                tone="info"
                title={C.scenario(scenario.caption)}
                action={
                  <Link to="/scenarios" className="shrink-0 text-sm font-medium underline underline-offset-2">
                    {C.change}
                  </Link>
                }
              >
                <ScenarioMeta id={scenario.id} />
              </Alert>
            )}
            <Card title={C.business} subtitle={C.businessSub}>
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
          <Card title={C.documents} subtitle={C.documentsSub}>
            <div className="grid gap-4 lg:grid-cols-3">
              {DOCUMENT_TYPES.map((t) => {
                const s = structured.find((d) => d.type === t)
                return (
                  <div key={t} className="space-y-2">
                    <FileDrop label={DOCUMENT_LABELS[t]} hint={`${UPLOAD_FORMATS_LABEL}, up to 5 MB`} file={files[t]} onChange={(f) => setFiles({ ...files, [t]: f })} />
                    {s && !files[t] && (
                      <div className="flex items-center gap-2 rounded-control bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-200">
                        <FileJson aria-hidden className="size-4 text-neutral-500" />
                        <span className="flex-1">{C.structuredFrom}</span>
                        <button
                          type="button"
                          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200"
                          aria-label={C.removeStructured(DOCUMENT_LABELS[t])}
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
              <summary className="cursor-pointer font-medium text-neutral-700 select-none">{C.advanced}</summary>
              <div className="mt-2">
                <Textarea
                  label={C.advancedLabel}
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
          <Card title={C.review}>
            <div className="grid gap-6 md:grid-cols-2">
              <dl className="space-y-2 text-sm">
                {FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                    <dt className="text-neutral-500">{label}</dt>
                    <dd className={cx('text-right', key !== 'merchant_name' && 'font-mono', !fields[key] && 'text-neutral-500')}>{fields[key] || C.notGiven}</dd>
                  </div>
                ))}
              </dl>
              <ul className="space-y-2 text-sm">
                {docSummary.map((d) => (
                  <li key={d.type} className="flex items-center justify-between gap-3 border-b border-neutral-100 pb-2">
                    <span className="text-neutral-500">{DOCUMENT_LABELS[d.type]}</span>
                    <span className={cx('truncate', d.source ? 'text-neutral-900' : 'text-warning-700')}>{d.source ?? C.missingDoc}</span>
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
                <Alert tone="danger" title={C.docRejected}>
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
            {C.back}
          </Button>
          {step < 2 ? (
            <Button type="submit" variant="primary">
              {C.continue} <ArrowRight aria-hidden className="size-4" />
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon={Send} loading={submit.isPending}>
              {C.send}
            </Button>
          )}
        </div>
      </form>
    </>
  )
}

/** Setup and expected outcome of a scenario, as metadata. */
function ScenarioMeta({ id }: { id: string }) {
  const meta = SC.meta[id]
  if (!meta) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt className="font-medium">{SC.setup}</dt>
      <dd>{meta.setup}</dd>
      <dt className="font-medium">{SC.outcome}</dt>
      <dd>{meta.outcome}</dd>
    </dl>
  )
}
