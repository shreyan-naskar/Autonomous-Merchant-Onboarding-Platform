import { useState, type ReactNode } from 'react'
import { APP_NAME, PageTitleContext } from '../lib/page-title.ts'

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState(APP_NAME)
  return <PageTitleContext.Provider value={{ title, setTitle }}>{children}</PageTitleContext.Provider>
}
