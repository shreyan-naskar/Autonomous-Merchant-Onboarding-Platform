import { ArrowLeft, LayoutList, MapPinOff } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '../components/ui.tsx'
import { usePageTitle } from '../lib/page-title.ts'

/** Rendered inside the shell, so navigation stays usable. Also used for a resource that doesn't exist. */
export function NotFound({ title = 'Page not found', message }: { title?: string; message?: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  usePageTitle(title)
  return (
    <section className="flex flex-col items-center px-4 py-16 text-center" aria-labelledby="nf-title">
      <div className="relative">
        <span className="absolute inset-0 -m-3 rounded-full bg-accent-50" aria-hidden />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-white text-accent-700 shadow-card ring-1 ring-accent-100">
          <MapPinOff aria-hidden className="size-7" />
        </span>
      </div>
      <p className="mt-6 text-xs font-semibold tracking-widest text-accent-700 uppercase">404</p>
      <h1 id="nf-title" className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
        {title}
      </h1>
      <p className="mt-2 max-w-md text-sm text-neutral-600">{message ?? "We couldn't find anything at this address."}</p>
      <p className="mt-3 rounded-control bg-neutral-100 px-2.5 py-1 font-mono text-xs text-neutral-600">{location.pathname}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={LayoutList} onClick={() => navigate('/')}>
          Go to applications
        </Button>
        <Button icon={ArrowLeft} onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    </section>
  )
}
