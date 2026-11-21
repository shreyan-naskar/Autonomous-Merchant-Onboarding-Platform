import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import App from '../App.tsx'
import { ToastProvider } from '../components/toast.tsx'
import { PageTitleProvider } from '../lib/pageTitle.tsx'

type Handler = (path: string, init?: RequestInit) => { status: number; body?: unknown } | undefined

/**
 * Stub fetch: `handler` answers by path ("/api/applications/..."); anything
 * it does not handle gets a harmless empty 200 for list endpoints. Returns
 * the mock so tests can assert on calls.
 */
export function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString()
    const r = handler(path, init) ?? defaults(path)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function defaults(path: string): { status: number; body?: unknown } {
  if (path.startsWith('/api/health')) return { status: 200, body: { status: 'ok', service: 'api' } }
  if (path.startsWith('/api/metrics')) return { status: 200, body: { total_applications: 0, exception_count: 0, exception_rate: 0, states: [] } }
  if (path.startsWith('/mock/admin/config'))
    return { status: 200, body: { delayMs: 1500, failKinds: [], duplicateCallback: false, dropCallback: false, lateCallbackMs: 0, outage: false } }
  if (path.startsWith('/api/admin/merchant-service')) return { status: 200, body: { fail: false } }
  return { status: 200, body: { items: [], count: 0 } }
}

export function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
}

export function Providers({ children, path = '/' }: { children: ReactNode; path?: string }) {
  return (
    <QueryClientProvider client={testClient()}>
      <MemoryRouter initialEntries={[path]}>
        <PageTitleProvider>
          <ToastProvider>{children}</ToastProvider>
        </PageTitleProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The whole app (shell + routes) at `path`. */
export function renderApp(path: string) {
  return render(
    <Providers path={path}>
      <App />
    </Providers>,
  )
}
