import { ArrowLeft, LayoutList, MapPinOff } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '../components/ui.tsx'
import { COMMON, NOT_FOUND } from '../copy.ts'
import { usePageTitle } from '../lib/page-title.ts'

/** Rendered inside the shell, so navigation stays usable. Also used for a resource that doesn't exist. */
export function NotFound({ title = NOT_FOUND.title, message }: { title?: string; message?: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  usePageTitle(title)
  return (
    <section className="flex flex-col items-center px-4 py-16 text-center" aria-labelledby="nf-title">
      <div className="relative">
        <span className="absolute inset-0 -m-3 rounded-full bg-accent-50" aria-hidden />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-white text-accent-700 ring-1 ring-accent-100">
          <MapPinOff aria-hidden className="size-7" />
        </span>
      </div>
      <p className="tabular mt-6 text-xs font-bold tracking-widest text-accent-500 uppercase">404</p>
      <h1 id="nf-title" className="mt-1 text-[1.75rem] leading-[1.08] font-semibold tracking-[-0.035em] text-accent-700">
        {title}
      </h1>
      <p className="mt-2 max-w-md text-sm text-neutral-600">{message ?? NOT_FOUND.text}</p>
      <p className="mt-3 rounded-control bg-neutral-100 px-2.5 py-1 font-mono text-xs text-neutral-600">{location.pathname}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={LayoutList} onClick={() => navigate('/')}>
          {COMMON.goHome}
        </Button>
        <Button icon={ArrowLeft} onClick={() => navigate(-1)}>
          {COMMON.goBack}
        </Button>
      </div>
    </section>
  )
}
