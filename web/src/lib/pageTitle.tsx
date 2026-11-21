import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/** The current page's title: shown in the top bar and as document.title. */
const PageTitleContext = createContext<{ title: string; setTitle: (t: string) => void } | null>(null)

export const APP_NAME = 'Merchant Onboarding'

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState(APP_NAME)
  return <PageTitleContext.Provider value={{ title, setTitle }}>{children}</PageTitleContext.Provider>
}

/** Pages call this (via PageHeader) to name themselves. */
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
