import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './app.tsx'
import { ToastProvider } from './components/toast-provider.tsx'
import './index.css'
import { PageTitleProvider } from './components/page-title-provider.tsx'
import { createQueryClient } from './lib/query-client.ts'

// Every query polls every 3s: the UI is a window onto the API, not a source of state.
const queryClient = createQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PageTitleProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PageTitleProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
