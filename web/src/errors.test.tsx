import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, PageError } from './components/errors.tsx'
import { ApiError } from './lib/api.ts'
import { mockFetch, Providers, renderApp } from './test/render.tsx'

const APP_ID = '0b0e7a2c-1111-4222-8333-444455556666'

describe('404 handling', () => {
  it('an unknown route renders NotFound inside the shell (navigation stays visible)', async () => {
    mockFetch(() => undefined)
    renderApp('/this/does/not/exist')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('/this/does/not/exist')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go to applications/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument()
    const nav = screen.getByRole('complementary', { name: 'Main navigation' })
    expect(within(nav).getByRole('link', { name: /applications/i })).toBeInTheDocument()
    expect(document.title).toBe('Page not found · Onboarding Console')
  })

  it('/applications/<id> answered 404 by the API renders NotFound with "No application with ID <id>"', async () => {
    const fetch = mockFetch((path) =>
      path === `/api/applications/${APP_ID}` ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Application not found' } } } : undefined,
    )
    renderApp(`/applications/${APP_ID}`)
    expect(await screen.findByRole('heading', { name: 'Application not found' })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`No application with ID ${APP_ID}`))).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(`/api/applications/${APP_ID}`, expect.anything())
  })

  it('a malformed application id renders NotFound without asking the API', async () => {
    const fetch = mockFetch(() => undefined)
    renderApp('/applications/not-an-id')
    expect(await screen.findByRole('heading', { name: 'Application not found' })).toBeInTheDocument()
    expect(screen.getByText(/No application with ID not-an-id/)).toBeInTheDocument()
    expect(fetch.mock.calls.map(([p]) => String(p))).not.toContain('/api/applications/not-an-id')
  })
})

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('kaboom in render')
  return <p>All good now</p>
}

describe('error boundary', () => {
  it('a component that throws renders "Unable to load this page."; Retry resets the boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function Harness() {
      const [explode, setExplode] = useState(true)
      return (
        <>
          <button onClick={() => setExplode(false)}>fix it</button>
          <ErrorBoundary>
            <Bomb explode={explode} />
          </ErrorBoundary>
        </>
      )
    }
    render(
      <Providers>
        <Harness />
      </Providers>,
    )
    expect(screen.getByRole('heading', { name: 'Unable to load this page.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go to applications/i })).toBeInTheDocument()
    // Dev build in tests: the technical details are available.
    expect(screen.getByText(/Technical details/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'fix it' }))
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(screen.getByText('All good now')).toBeInTheDocument()
  })

  it('a crash inside a routed page keeps the shell and shows the error page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The list page crashes if the API returns garbage instead of {items, count}.
    mockFetch((path) => (path.startsWith('/api/applications?') ? { status: 200, body: { items: 42, count: 'x' } } : undefined))
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Unable to load this page.' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Main navigation' })).toBeInTheDocument()
  })
})

describe('PageError', () => {
  it('5xx -> full-page server error with a working Retry', async () => {
    const retry = vi.fn()
    render(
      <Providers>
        <PageError error={new ApiError('boom', 500, 'INTERNAL')} onRetry={retry} />
      </Providers>,
    )
    expect(screen.getByRole('heading', { name: 'Unable to load this page.' })).toBeInTheDocument()
    expect(screen.getByText('500')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(retry).toHaveBeenCalled()
  })

  it('network error -> keeps the page (no error page), says it is waiting', () => {
    render(
      <Providers>
        <PageError error={new ApiError("Can't reach the server", 0, 'NETWORK')} />
      </Providers>,
    )
    expect(screen.queryByRole('heading', { name: /unable to load|not found/i })).toBeNull()
    expect(screen.getByText('Service unavailable. Reconnecting…')).toBeInTheDocument()
  })
})
