import { Home, RefreshCw, ServerCrash, TriangleAlert, WifiOff } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { isNetworkError, isNotFound, isServerError } from '../lib/api.ts'
import { useServerReachable } from '../lib/connection.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { NotFound } from '../pages/not-found.tsx'
import { COMMON, ERRORS } from '../copy.ts'
import { Alert, Button, ErrorAlert, SkeletonRows } from './ui.tsx'

/* A lost connection never replaces the page: the offline banner covers it while the last data stays visible. */

export function PageError({
  error,
  onRetry,
  notFoundTitle = ERRORS.notFound,
  notFoundMessage,
}: {
  error: unknown
  onRetry?: () => void
  notFoundTitle?: string
  notFoundMessage?: string
}) {
  if (isNotFound(error)) return <NotFound title={notFoundTitle} message={notFoundMessage} />
  if (isServerError(error)) return <ServerErrorPage onRetry={onRetry} />
  if (isNetworkError(error)) {
    return (
      <div className="space-y-4">
        <Alert tone="warning" title={ERRORS.waitingTitle}>
          {ERRORS.waitingText}
        </Alert>
        <SkeletonRows rows={4} />
      </div>
    )
  }
  return <ErrorAlert error={error} />
}

function ServerErrorPage({ onRetry }: { onRetry?: () => void }) {
  usePageTitle(ERRORS.serverDocTitle)
  return (
    <ErrorScreen
      icon={ServerCrash}
      code="500"
      title={ERRORS.pageTitle}
      text={ERRORS.serverText}
      actions={
        onRetry && (
          <Button variant="primary" icon={RefreshCw} onClick={onRetry}>
            {COMMON.retry}
          </Button>
        )
      }
    />
  )
}

function ErrorScreen({ icon: Icon, code, title, text, actions, children }: { icon: typeof ServerCrash; code?: string; title: string; text: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center" role="alert">
      <span className="flex size-16 items-center justify-center rounded-full bg-danger-50 text-danger-700 ring-1 ring-danger-200">
        <Icon aria-hidden className="size-7" />
      </span>
      {code && <p className="tabular mt-6 text-xs font-bold tracking-widest text-danger-700 uppercase">{code}</p>}
      <h1 className="mt-1 text-[1.75rem] leading-[1.08] font-semibold tracking-[-0.035em] text-accent-700">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-600">{text}</p>
      {actions && <div className="mt-8 flex flex-wrap justify-center gap-2">{actions}</div>}
      {children}
    </div>
  )
}

/** The stack is shown in development builds only, and nothing from API responses is ever shown. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Navigating elsewhere clears the error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <ErrorScreen
        icon={TriangleAlert}
        title={ERRORS.pageTitle}
        text={ERRORS.pageText}
        actions={
          <>
            <Button variant="primary" icon={RefreshCw} onClick={this.reset}>
              {COMMON.retry}
            </Button>
            <Button
              icon={Home}
              onClick={() => {
                this.reset()
                window.location.assign('/')
              }}
            >
              {COMMON.goHome}
            </Button>
          </>
        }
      >
        {import.meta.env.DEV && (
          <details className="mt-8 w-full max-w-2xl text-left">
            <summary className="cursor-pointer text-xs text-neutral-500">{ERRORS.technical}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-control bg-neutral-900 p-3 font-mono text-2xs text-neutral-100">
              {error.name}: {error.message}
              {'\n'}
              {error.stack}
            </pre>
          </details>
        )}
      </ErrorScreen>
    )
  }
}

export function OfflineBanner() {
  const reachable = useServerReachable()
  if (reachable) return null
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-800 sm:px-6 lg:px-8">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span>
        <b>{ERRORS.offline}</b> {ERRORS.offlineDetail}
      </span>
    </div>
  )
}
