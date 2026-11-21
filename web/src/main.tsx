import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import { ToastProvider } from './components/toast.tsx'
import { PageTitleProvider } from './lib/pageTitle.tsx'
import './index.css'

// Every query polls every 3s: the UI is a window onto the API, not a source of state.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 3000, retry: 1 } },
})

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
