import type { ApplicationDetailDto } from '@app/shared'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { BankChangeForm } from '../components/BankChangeForm.tsx'
import { ExtractedFields } from '../components/ExtractedFields.tsx'
import { MissingInfoPanel } from '../components/MissingInfoPanel.tsx'
import { ReviewTaskList } from '../components/ReviewTaskList.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { Timeline } from '../components/Timeline.tsx'
import { VerificationCards } from '../components/VerificationCards.tsx'
import { Card, ErrorBox, Loading } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { duration } from '../lib/format.ts'

export function ApplicationDetail() {
  const { id = '' } = useParams()
  const { data: app, error, isPending } = useQuery({
    queryKey: ['application', id],
    queryFn: () => api.get<ApplicationDetailDto>(`/applications/${id}`),
  })
  if (isPending) return <Loading />
  if (!app) return <ErrorBox error={error} />

  return (
    <div className="space-y-4">
      <Link to="/" className="text-sm text-slate-500 hover:underline">
        ← Applications
      </Link>
      <ErrorBox error={error} />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{app.merchant_name}</h1>
        <StatusBadge status={app.status} />
        <span className="text-sm text-slate-500">for {duration(app.time_in_state_ms)}</span>
        {app.merchant_id && (
          <span className="rounded bg-green-600 px-2 py-0.5 font-mono text-sm font-semibold text-white">{app.merchant_id}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-4">
        <Field label="PAN">{app.pan}</Field>
        <Field label="GSTIN">{app.gst}</Field>
        <Field label="Bank account">{app.bank_account}</Field>
        <Field label="IFSC">{app.ifsc}</Field>
        <Field label="Bank version">{app.bank_version}</Field>
        <Field label="Merchant ID">{app.merchant_id}</Field>
        <Field label="Submitted">{new Date(app.created_at).toLocaleString()}</Field>
        <Field label="Application id">{app.id}</Field>
      </dl>

      {app.status === 'NEEDS_INFO' && <MissingInfoPanel app={app} />}

      {app.review_tasks.length > 0 && (
        <Card title="Review tasks">
          <ReviewTaskList tasks={app.review_tasks} applicationId={app.id} status={app.status} />
        </Card>
      )}

      <Card title="Verifications">
        <VerificationCards app={app} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Extracted fields">
            <ExtractedFields fields={app.extracted_fields} />
          </Card>
          <Card title="Change bank details (merchant)">
            <BankChangeForm app={app} />
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Card title={`Timeline (${app.audit_log.length})`}>
            <Timeline entries={app.audit_log} />
          </Card>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate font-mono text-xs">{children ?? '—'}</dd>
    </div>
  )
}
