import { Home, RefreshCw, ServerCrash, TriangleAlert, WifiOff } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { friendlyError, isNetworkError, isNotFound, isServerError } from '../lib/api.ts'
import { useServerReachable } from '../lib/connection.ts'
import { usePageTitle } from '../lib/pageTitle.tsx'
import { NotFound } from '../pages/NotFound.tsx'
import { Alert, Button, ErrorAlert, SkeletonRows } from './ui.tsx'

/* A lost connection never replaces the page: the offline banner covers it while the last data stays visible. */

export function PageError({
  error,
  onRetry,
  notFoundTitle = 'Not found',
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
        <Alert tone="warning" title="Waiting for the server">
          This page will load as soon as the server answers.
        </Alert>
        <SkeletonRows rows={4} />
      </div>
    )
  }
  return <ErrorAlert error={error} />
}

export function ServerErrorPage({ onRetry }: { onRetry?: () => void }) {
  usePageTitle('Server error')
  return (
    <ErrorScreen
      icon={ServerCrash}
      code="500"
      title="The server had a problem"
      text="This isn't something you did. Try again in a moment; if it keeps happening, check the API logs."
      actions={
        onRetry && (
          <Button variant="primary" icon={RefreshCw} onClick={onRetry}>
            Retry
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
      {code && <p className="mt-6 text-xs font-semibold tracking-widest text-danger-700 uppercase">{code}</p>}
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
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

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed', error, info.componentStack)
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
        title="Something went wrong"
        text="This page hit an unexpected problem. Retrying usually helps; your data is safe on the server."
        actions={
          <>
            <Button variant="primary" icon={RefreshCw} onClick={this.reset}>
              Retry
            </Button>
            <Button
              icon={Home}
              onClick={() => {
                this.reset()
                window.location.assign('/')
              }}
            >
              Go home
            </Button>
          </>
        }
      >
        {import.meta.env.DEV && (
          <details className="mt-8 w-full max-w-2xl text-left">
            <summary className="cursor-pointer text-xs text-neutral-500">Technical details (development only)</summary>
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
        <b>Can't reach the server, retrying…</b> Pages keep showing the last data they loaded.
      </span>
    </div>
  )
}

export const toastFor = (error: unknown) => {
  const f = friendlyError(error)
  return { title: f.title, message: f.message }
}
