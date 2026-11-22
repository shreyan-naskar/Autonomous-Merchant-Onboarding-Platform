import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, Input } from './ui.tsx'

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onClose={() => {
          onClose()
          setOpen(false)
        }}
        title="Confirm"
        description="Are you sure?"
        footer={<button>Confirm it</button>}
      >
        <input aria-label="Note" data-autofocus />
      </Dialog>
    </>
  )
}

describe('Dialog accessibility', () => {
  it('is a labelled modal, focuses [data-autofocus], traps Tab, closes on Esc and restores focus', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))

    const dialog = screen.getByRole('dialog', { name: 'Confirm' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Are you sure?')
    expect(screen.getByLabelText('Note')).toHaveFocus()

    // Tab order inside: close (X), Note, Confirm it -> wraps around, never leaves the dialog.
    await user.tab()
    expect(screen.getByRole('button', { name: 'Confirm it' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Confirm it' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
  })
})

describe('Input', () => {
  it('links its label, hint and error text for screen readers', () => {
    const { rerender } = render(<Input label="PAN" hint="5 letters, 4 digits, 1 letter" />)
    const input = screen.getByLabelText('PAN')
    expect(input).toHaveAccessibleDescription('5 letters, 4 digits, 1 letter')
    rerender(<Input label="PAN" hint="5 letters, 4 digits, 1 letter" error="PAN must be 5 letters, 4 digits, 1 letter" />)
    expect(screen.getByLabelText('PAN')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('PAN')).toHaveAccessibleDescription('PAN must be 5 letters, 4 digits, 1 letter')
  })
})
