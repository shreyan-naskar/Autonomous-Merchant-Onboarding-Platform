import { Route, Routes, useLocation } from 'react-router'
import { AppShell } from './components/AppShell.tsx'
import { ChaosBanner } from './components/Banners.tsx'
import { ErrorBoundary, OfflineBanner } from './components/errors.tsx'
import { ApplicationDetail } from './pages/ApplicationDetail.tsx'
import { ApplicationList } from './pages/ApplicationList.tsx'
import { DeadLetters } from './pages/DeadLetters.tsx'
import { DemoPanel } from './pages/DemoPanel.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { ReviewQueue } from './pages/ReviewQueue.tsx'
import { SubmitApplication } from './pages/SubmitApplication.tsx'

/** Routes inside the shell, so navigation stays visible on 404s and crashes. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ApplicationList />} />
      <Route path="/applications/:id" element={<ApplicationDetail />} />
      <Route path="/review" element={<ReviewQueue />} />
      <Route path="/submit" element={<SubmitApplication />} />
      <Route path="/dead-letters" element={<DeadLetters />} />
      <Route path="/demo" element={<DemoPanel />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export default function App() {
  const location = useLocation()
  return (
    <AppShell
      banners={
        <>
          <OfflineBanner />
          <ChaosBanner />
        </>
      }
    >
      <ErrorBoundary resetKey={location.pathname}>
        <AppRoutes />
      </ErrorBoundary>
    </AppShell>
  )
}
