import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockFetch, renderApp } from '../test/render.tsx'

const APP_ID = '0b0e7a2c-1111-4222-8333-444455556666'
const CAPTIONS = [
  'PAN verification succeeds but GST verification fails.',
  'The same callback arrives multiple times.',
  'A callback arrives after the request timed out.',
  'The merchant changes bank details after verification.',
  'Approval succeeds but merchant ID creation fails.',
  'A document is blurred or conflicts with the application form.',
]

describe('submitting an application', () => {
  it('starts empty, with no sample cards', async () => {
    mockFetch(() => undefined)
    renderApp('/submit')
    expect(await screen.findByLabelText(/business name/i)).toHaveValue('')
    expect(screen.queryByText('Start from a sample')).not.toBeInTheDocument()
    expect(screen.queryByText(CAPTIONS[0]!)).not.toBeInTheDocument()
  })

  it('shows "Submitted for verification" with the reference, and does not open the application', async () => {
    const fetch = mockFetch((path, init) =>
      path === '/api/applications' && init?.method === 'POST'
        ? { status: 201, body: { id: APP_ID, merchant_name: 'Lakshmi Textiles Pvt Ltd', status: 'SUBMITTED' } }
        : undefined,
    )
    const user = userEvent.setup()
    renderApp('/scenarios')
    await user.click(await screen.findByRole('button', { name: `Start: ${CAPTIONS[1]}` }))
    await user.click(await screen.findByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /submit application/i }))

    expect(await screen.findByRole('heading', { name: 'Submitted for verification' })).toBeInTheDocument()
    expect(screen.getByText(APP_ID)).toBeInTheDocument()
    expect(screen.getByText(CAPTIONS[1]!)).toBeInTheDocument()
    expect(screen.getByText('Expected outcome')).toBeInTheDocument()
    expect(fetch.mock.calls.map(([p]) => String(p))).not.toContain(`/api/applications/${APP_ID}`)

    await user.click(screen.getByRole('button', { name: /submit another application/i }))
    expect(await screen.findByLabelText(/business name/i)).toHaveValue('')
  })
})

describe('the Scenarios page', () => {
  it('lists the six cases with the captions from the problem statement', async () => {
    mockFetch(() => undefined)
    renderApp('/scenarios')
    for (const caption of CAPTIONS) expect(await screen.findByText(caption)).toBeInTheDocument()
  })

  it('starting one sets its switches, turns the others off and opens the pre-filled form', async () => {
    const fetch = mockFetch(() => undefined)
    const user = userEvent.setup()
    renderApp('/scenarios')
    await user.click(await screen.findByRole('button', { name: `Start: ${CAPTIONS[1]}` }))

    expect(await screen.findByText(`Scenario: ${CAPTIONS[1]}`)).toBeInTheDocument()
    expect(screen.getByLabelText(/business name/i)).toHaveValue('Lakshmi Textiles Pvt Ltd')
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    const body = (path: string) => JSON.parse(String(posts.find(([p]) => String(p) === path)?.[1]?.body))
    expect(body('/mock/admin/config')).toEqual({ failKinds: [], duplicateCallback: true, dropCallback: false, lateCallbackMs: 0, outage: false })
    expect(body('/api/admin/merchant-service')).toEqual({ fail: false })
  })
})
