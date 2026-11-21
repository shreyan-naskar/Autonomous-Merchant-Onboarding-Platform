import {
  ArchiveX,
  ClipboardCheck,
  FilePlus2,
  FlaskConical,
  LayoutList,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { STATUS_LABELS } from '@app/shared'
import { useCurrentTitle } from '../lib/pageTitle.tsx'
import { useApplications, useDeadJobs, useHealth, useOpenTasks } from '../lib/queries.ts'
import { Tooltip, cx } from './ui.tsx'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  count?: number
  countTone?: 'warning' | 'danger'
}

const COLLAPSE_KEY = 'mo.sidebar.collapsed'
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

export function AppShell({ children, banners }: { children: ReactNode; banners?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  const tasks = useOpenTasks()
  const dead = useDeadJobs()

  useEffect(() => setDrawer(false), [location.pathname])
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* private mode: not remembered */
    }
  }, [collapsed])

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Operations',
      items: [
        { to: '/', label: 'Applications', icon: LayoutList },
        { to: '/review', label: 'Review queue', icon: ClipboardCheck, count: tasks.data?.count, countTone: 'warning' },
      ],
    },
    { title: 'Merchant', items: [{ to: '/submit', label: 'Submit application', icon: FilePlus2 }] },
    {
      title: 'Admin',
      items: [
        { to: '/dead-letters', label: 'Dead letters', icon: ArchiveX, count: dead.data?.count, countTone: 'danger' },
        { to: '/demo', label: 'Demo controls', icon: FlaskConical },
      ],
    },
  ]

  return (
    <div className="min-h-screen lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>

      {drawer && <div className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden" aria-hidden onClick={() => setDrawer(false)} />}

      <aside
        aria-label="Main navigation"
        onKeyDown={(e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)}
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-neutral-200 bg-white transition-[width,transform] duration-200',
          'lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          drawer ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'w-64 lg:w-16' : 'w-64',
        )}
      >
        <div className={cx('flex h-14 items-center gap-2 border-b border-neutral-100 px-4', collapsed && 'lg:justify-center lg:px-0')}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-700 text-white">
            <ShieldCheck aria-hidden className="size-4.5" />
          </span>
          <div className={cx('min-w-0 leading-tight', collapsed && 'lg:hidden')}>
            <div className="truncate text-sm font-semibold text-neutral-900">Merchant Onboarding</div>
            <div className="text-2xs text-neutral-500">Operations console</div>
          </div>
          <button type="button" className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-100 lg:hidden" aria-label="Close navigation" onClick={() => setDrawer(false)}>
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {groups.map((g) => (
            <div key={g.title}>
              <div className={cx('mb-1 px-2 text-2xs font-semibold tracking-wider text-neutral-400 uppercase', collapsed && 'lg:sr-only')}>{g.title}</div>
              <ul className="space-y-0.5">
                {g.items.map((item) => (
                  <li key={item.to}>
                    <SideLink item={item} collapsed={collapsed} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="hidden items-center gap-2 border-t border-neutral-100 px-5 py-3 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800 lg:flex"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
          <span className={cx(collapsed && 'lg:sr-only')}>Collapse</span>
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        <TopBar onMenu={() => setDrawer(true)} />
        {banners}
        <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 focus:outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  )
}

function SideLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cx(
          'group relative flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-accent-50 text-accent-800' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
          collapsed && 'lg:justify-center',
        )
      }
    >
      <item.icon aria-hidden className="size-4.5 shrink-0" />
      <span className={cx('flex-1 truncate', collapsed && 'lg:sr-only')}>{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span
          className={cx(
            'tabular min-w-5 rounded-full px-1.5 text-center text-2xs font-semibold text-white',
            item.countTone === 'danger' ? 'bg-danger-600' : 'bg-warning-600',
            collapsed && 'lg:absolute lg:top-0 lg:right-0 lg:min-w-4 lg:px-1',
          )}
          aria-label={`${item.count} open`}
        >
          {item.count}
        </span>
      )}
    </NavLink>
  )
  return collapsed ? (
    <Tooltip content={item.label} className="flex">
      <span className="w-full">{link}</span>
    </Tooltip>
  ) : (
    link
  )
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const title = useCurrentTitle()
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-neutral-200 bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button type="button" onClick={onMenu} className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100 lg:hidden" aria-label="Open navigation">
        <Menu aria-hidden className="size-5" />
      </button>
      <div className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900" aria-live="polite">
        {title}
      </div>
      <GlobalSearch />
      <HealthDot />
    </header>
  )
}

function HealthDot() {
  const h = useHealth()
  const state = h.isError ? 'down' : h.isSuccess ? 'up' : 'unknown'
  const text = state === 'up' ? 'API online' : state === 'down' ? 'API unreachable' : 'Checking API…'
  return (
    <Tooltip content={text} side="bottom">
      <span tabIndex={0} role="status" aria-label={text} className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-xs text-neutral-500">
        <span className={cx('size-2.5 rounded-full', state === 'up' ? 'bg-success-500' : state === 'down' ? 'bg-danger-500 animate-pulse' : 'bg-neutral-300')} />
        <span className="hidden xl:inline">{text}</span>
      </span>
    </Tooltip>
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function GlobalSearch() {
  const apps = useApplications()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    return (apps.data?.items ?? []).filter((a) => a.merchant_name.toLowerCase().includes(term) || a.id.toLowerCase().startsWith(term)).slice(0, 8)
  }, [q, apps.data])

  const go = (id: string) => {
    setQ('')
    setOpen(false)
    navigate(`/applications/${id}`)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const pick = results[active]
      if (pick) go(pick.id)
      else if (UUID_RE.test(q.trim())) go(q.trim())
    } else if (e.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    }
  }

  return (
    <div className="relative w-40 sm:w-72">
      <label htmlFor="global-search" className="sr-only">
        Search applications by merchant name or ID
      </label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-neutral-400" />
      <input
        ref={input}
        id="global-search"
        type="search"
        role="combobox"
        aria-expanded={open && q !== ''}
        aria-controls="global-search-results"
        aria-activedescendant={results[active] ? `gs-${results[active].id}` : undefined}
        autoComplete="off"
        placeholder="Search merchant or ID…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-control border border-neutral-300 bg-neutral-50 pr-10 pl-8 text-sm placeholder:text-neutral-400 focus:border-accent-600 focus:bg-white focus:ring-2 focus:ring-accent-600/20 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-neutral-300 px-1 text-2xs text-neutral-400 sm:block">/</kbd>
      {open && q.trim() !== '' && (
        <ul id="global-search-results" role="listbox" className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-auto rounded-card border border-neutral-200 bg-white py-1 shadow-overlay">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">{UUID_RE.test(q.trim()) ? 'Press Enter to open this ID' : 'No matching applications'}</li>
          ) : (
            results.map((a, i) => (
              <li
                key={a.id}
                id={`gs-${a.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  go(a.id)
                }}
                onMouseEnter={() => setActive(i)}
                className={cx('cursor-pointer px-3 py-2', i === active && 'bg-accent-50')}
              >
                <div className="truncate text-sm font-medium text-neutral-900">{a.merchant_name}</div>
                <div className="flex items-center gap-2 text-2xs text-neutral-500">
                  <span className="font-mono">{a.id.slice(0, 8)}</span>
                  <span>{STATUS_LABELS[a.status].label}</span>
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
