import { Route, Routes, useLocation } from 'react-router'
import { AppShell } from './components/app-shell.tsx'
import { ChaosBanner } from './components/banners.tsx'
import { ErrorBoundary, OfflineBanner } from './components/errors.tsx'
import { ApplicationDetail } from './pages/application-detail.tsx'
import { ApplicationList } from './pages/application-list.tsx'
import { DeadLetters } from './pages/dead-letters.tsx'
import { DemoPanel } from './pages/demo-panel.tsx'
import { NotFound } from './pages/not-found.tsx'
import { ReviewQueue } from './pages/review-queue.tsx'
import { Scenarios } from './pages/scenarios.tsx'
import { SubmitApplication } from './pages/submit-application.tsx'

/** Routes inside the shell, so navigation stays visible on 404s and crashes. */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ApplicationList />} />
      <Route path="/applications/:id" element={<ApplicationDetail />} />
      <Route path="/review" element={<ReviewQueue />} />
      <Route path="/submit" element={<SubmitApplication />} />
      <Route path="/scenarios" element={<Scenarios />} />
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
