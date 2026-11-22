import { APPLICATION_ID_RE, STATUS_LABELS, type ApplicationDetailDto, type ApplicationStatus } from '@app/shared'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck, FileQuestion, Hourglass, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { BankDetails, DocumentsList, ExtractedFields, Stepper, Timeline, VerificationCards } from '../components/application.tsx'
import { PageError } from '../components/errors.tsx'
import { MissingInfoPanel } from '../components/missing-info-panel.tsx'
import { TaskActions, TaskCard } from '../components/review.tsx'
import { currentChecksOf } from '../lib/status.ts'
import { useToast } from '../lib/toast.ts'
import { Button, Card, CopyButton, PageHeader, Skeleton, TabPanel, Tabs } from '../components/ui.tsx'
import { cx } from '../lib/tone.ts'
import { api } from '../lib/api.ts'
import { dateTime, duration, relativeTime } from '../lib/format.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import { qk } from '../lib/queries.ts'
import { NotFound } from './not-found.tsx'
import { COMMON, DETAIL as C, NAV, NOT_FOUND } from '../copy.ts'

const missing = NOT_FOUND.applicationText

type TabId = 'overview' | 'timeline' | 'documents' | 'bank'
const TAB_IDS: readonly TabId[] = ['overview', 'timeline', 'documents', 'bank']

export function ApplicationDetail() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (TAB_IDS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabId) : 'overview'
  const setTab = (t: TabId) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })

  const validId = APPLICATION_ID_RE.test(id)
  const { data: app, error, isPending, refetch } = useQuery({
    queryKey: qk.application(id),
    queryFn: () => api.get<ApplicationDetailDto>(`/applications/${id}`),
    enabled: validId,
  })
  const flash = useStatusChange(app)

  if (!validId) return <NotFound title={NOT_FOUND.application} message={missing(id)} />
  if (isPending) return <DetailSkeleton />
  if (!app) return <PageError error={error} onRetry={() => void refetch()} notFoundTitle={NOT_FOUND.application} notFoundMessage={missing(id)} />

  const openTasks = app.review_tasks.filter((t) => t.status === 'OPEN')
  const goTo = (target: string) => {
    setTab('overview')
    setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumbs={[{ label: NAV.applications, to: '/' }, { label: app.merchant_name }]}
        docTitle={app.merchant_name}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {app.merchant_name}
            <span key={app.status} className={cx('rounded-full', flash && 'ring-2 ring-success-600 ring-offset-2')} aria-live="polite">
              <StatusBadge status={app.status} />
            </span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{STATUS_LABELS[app.status].description}</span>
            <span className="hidden text-neutral-500 sm:inline">·</span>
            <span>
              {C.inState} <span className="tabular">{duration(app.time_in_state_ms)}</span>
            </span>
            <span className="hidden text-neutral-500 sm:inline">·</span>
            <span title={dateTime(app.created_at)}>
              {C.submitted} {relativeTime(app.created_at)}
            </span>
          </span>
        }
        actions={<NextAction app={app} onGo={goTo} />}
      />

      <Card padded={false}>
        <div className="space-y-4 p-4">
          <Stepper app={app} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-neutral-100 pt-3 text-sm sm:grid-cols-4">
            <HeaderField label={C.mid}>
              {app.merchant_id ? (
                <span className="inline-flex items-center gap-1 font-mono text-success-800">
                  {app.merchant_id}
                  <CopyButton value={app.merchant_id} label={C.copyMid} />
                </span>
              ) : (
                '—'
              )}
            </HeaderField>
            <HeaderField label={COMMON.pan} masked>
              {app.pan}
            </HeaderField>
            <HeaderField label={COMMON.gstin} masked>
              {app.gst}
            </HeaderField>
            <HeaderField label={C.applicationId}>
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{app.id.slice(0, 8)}…</span>
                <CopyButton value={app.id} label={C.copyId} />
              </span>
            </HeaderField>
          </dl>
        </div>
      </Card>

      <div>
        <Tabs<TabId>
          label={C.sections}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: C.tabs.overview, count: openTasks.length || undefined },
            { id: 'timeline', label: C.tabs.timeline, count: app.audit_log.length },
            { id: 'documents', label: C.tabs.documents, count: app.documents.length },
            { id: 'bank', label: C.tabs.bank },
          ]}
        />
        {tab === 'overview' && (
          <TabPanel id="overview">
            <div className="space-y-5">
              {app.status === 'NEEDS_INFO' && <MissingInfoPanel app={app} />}
              {app.review_tasks.length > 0 && (
                <section id="review-tasks" className="scroll-mt-24 space-y-3" aria-labelledby="tasks-title">
                  <h2 id="tasks-title" className="text-sm font-semibold text-neutral-900">
                    {C.reviewTasks}
                  </h2>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {[...app.review_tasks].reverse().map((t) => (
                      <TaskCard key={t.id} task={t} applicationId={app.id} merchantName={app.merchant_name} status={app.status} checks={app.check_progress} showApplication={false} app={app} currentChecks={currentChecksOf(app)} />
                    ))}
                  </div>
                </section>
              )}
              <Card title={C.verification} subtitle={C.verificationSub}>
                <VerificationCards app={app} />
              </Card>
              <Card title={C.extracted} subtitle={C.extractedSub} padded={false}>
                <div className="px-4 py-2">
                  <ExtractedFields app={app} />
                </div>
              </Card>
            </div>
          </TabPanel>
        )}
        {tab === 'timeline' && (
          <TabPanel id="timeline">
            <Card title={C.audit} subtitle={C.auditSub}>
              <Timeline entries={app.audit_log} />
            </Card>
          </TabPanel>
        )}
        {tab === 'documents' && (
          <TabPanel id="documents">
            <DocumentsList app={app} />
          </TabPanel>
        )}
        {tab === 'bank' && (
          <TabPanel id="bank">
            <BankDetails app={app} />
          </TabPanel>
        )}
      </div>
    </div>
  )
}

/** Masked values (PAN, GSTIN) are shown in muted monospace. */
function HeaderField({ label, children, masked }: { label: string; children: React.ReactNode; masked?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className={cx('truncate font-mono text-sm', masked ? 'text-neutral-500' : 'text-neutral-900')}>{children ?? '—'}</dd>
    </div>
  )
}

/** The one thing to do next, depending on the state. */
function NextAction({ app, onGo }: { app: ApplicationDetailDto; onGo: (target: string) => void }) {
  const openTasks = app.review_tasks.filter((t) => t.status === 'OPEN')
  switch (app.status) {
    case 'NEEDS_INFO':
      return (
        <Button variant="primary" icon={FileQuestion} onClick={() => onGo('missing-info')}>
          {C.provideInfo}
        </Button>
      )
    case 'IN_REVIEW':
      return (
        <Button variant="primary" icon={ClipboardCheck} onClick={() => onGo('review-tasks')}>
          {C.review(openTasks.length)}
        </Button>
      )
    case 'MERCHANT_CREATION_FAILED': {
      const task = openTasks.find((t) => t.reason === 'MERCHANT_CREATION_FAILED')
      return task ? (
        <TaskActions task={task} applicationId={app.id} merchantName={app.merchant_name} status={app.status} checks={app.check_progress} size="md" />
      ) : (
        <Button variant="primary" icon={RotateCcw} onClick={() => onGo('review-tasks')}>
          {C.retryMerchant}
        </Button>
      )
    }
    case 'MERCHANT_CREATED':
      return null
    case 'REJECTED':
      return null
    default:
      return <WaitingChip status={app.status} />
  }
}

function WaitingChip({ status }: { status: ApplicationStatus }) {
  return (
    <span className="inline-flex h-9 items-center gap-1.5 rounded-control bg-neutral-100 px-3 text-sm text-neutral-600" role="status">
      <Hourglass aria-hidden className="size-4" />
      {C.waiting[status] ?? C.inProgress}
    </span>
  )
}

/** Toast + soft highlight when a live update changes the status. */
function useStatusChange(app: ApplicationDetailDto | undefined) {
  const toast = useToast()
  const prev = useRef<{ id: string; status: ApplicationStatus } | null>(null)
  const [flash, setFlash] = useState(false)
  const id = app?.id
  const status = app?.status
  const name = app?.merchant_name
  useEffect(() => {
    if (!id || !status) return
    const before = prev.current
    prev.current = { id, status }
    if (!before || before.id !== id || before.status === status) return
    const s = STATUS_LABELS[status]
    toast.push({ tone: s.severity === 'danger' ? 'error' : s.severity === 'success' ? 'success' : 'info', title: C.statusChanged(s.label), message: name })
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1700)
    return () => clearTimeout(t)
  }, [id, status, name, toast])
  return flash
}

function DetailSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label={C.loading}>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-8 w-80" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  )
}
