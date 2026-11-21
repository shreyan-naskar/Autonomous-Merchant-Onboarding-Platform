import { FlaskConical } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { useChaosModes } from '../lib/chaos.ts'
import { Button } from './ui.tsx'

/** Visible on every page while any demo failure mode is on, so nobody is surprised by a "failure". */
export function ChaosBanner() {
  const { modes, busy, resetAll } = useChaosModes()
  const location = useLocation()
  const on = modes.filter((m) => m.on)
  if (on.length === 0) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning-200 bg-warning-50 px-4 py-2 text-sm text-warning-800 sm:px-6 lg:px-8">
      <FlaskConical aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <b>Demo failure mode on:</b> {on.map((m) => m.label).join(', ')}
      </span>
      {location.pathname !== '/demo' && (
        <Link to="/demo" className="font-medium underline underline-offset-2 hover:text-warning-700">
          Demo controls
        </Link>
      )}
      <Button size="sm" onClick={resetAll} loading={busy}>
        Turn all off
      </Button>
    </div>
  )
}
