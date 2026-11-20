import { NavLink, Route, Routes } from 'react-router'
import { ApplicationDetail } from './pages/ApplicationDetail.tsx'
import { ApplicationList } from './pages/ApplicationList.tsx'
import { ReviewQueue } from './pages/ReviewQueue.tsx'
import { SubmitApplication } from './pages/SubmitApplication.tsx'

const NAV = [
  { to: '/', label: 'Applications' },
  { to: '/review', label: 'Review queue' },
  { to: '/submit', label: 'Submit' },
]

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Merchant Onboarding</span>
          <nav className="flex gap-4 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) => (isActive ? 'font-semibold text-slate-900' : 'text-slate-500 hover:text-slate-800')}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <Routes>
          <Route path="/" element={<ApplicationList />} />
          <Route path="/applications/:id" element={<ApplicationDetail />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/submit" element={<SubmitApplication />} />
        </Routes>
      </main>
    </div>
  )
}
