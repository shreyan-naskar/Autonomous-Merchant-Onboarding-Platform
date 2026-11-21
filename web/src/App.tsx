import { Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell.tsx'
import { ChaosBanner } from './components/Banners.tsx'
import { ApplicationDetail } from './pages/ApplicationDetail.tsx'
import { ApplicationList } from './pages/ApplicationList.tsx'
import { DeadLetters } from './pages/DeadLetters.tsx'
import { DemoPanel } from './pages/DemoPanel.tsx'
import { ReviewQueue } from './pages/ReviewQueue.tsx'
import { SubmitApplication } from './pages/SubmitApplication.tsx'

export default function App() {
  return (
    <AppShell banners={<ChaosBanner />}>
      <Routes>
        <Route path="/" element={<ApplicationList />} />
        <Route path="/applications/:id" element={<ApplicationDetail />} />
        <Route path="/review" element={<ReviewQueue />} />
        <Route path="/submit" element={<SubmitApplication />} />
        <Route path="/dead-letters" element={<DeadLetters />} />
        <Route path="/demo" element={<DemoPanel />} />
      </Routes>
    </AppShell>
  )
}
