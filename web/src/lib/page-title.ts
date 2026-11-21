import { createContext, useContext, useEffect } from 'react'

/** The current page's title: shown in the top bar and as document.title. */
export const PageTitleContext = createContext<{ title: string; setTitle: (t: string) => void } | null>(null)

export const APP_NAME = 'Merchant Onboarding'

export function usePageTitle(title: string) {
  const ctx = useContext(PageTitleContext)
  const setTitle = ctx?.setTitle
  useEffect(() => {
    document.title = title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`
    setTitle?.(title)
  }, [title, setTitle])
}

export function useCurrentTitle(): string {
  return useContext(PageTitleContext)?.title ?? APP_NAME
}
