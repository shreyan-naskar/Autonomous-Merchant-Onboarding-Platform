import {
  ArchiveX,
  ClipboardCheck,
  FilePlus2,
  FlaskConical,
  LayoutList,
  ListChecks,
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
import { APPLICATION_ID_RE, STATUS_LABELS } from '@app/shared'
import { HEALTH, NAV, PRODUCT, SEARCH } from '../copy.ts'
import { useCurrentTitle } from '../lib/page-title.ts'
import { useApplications, useDeadJobs, useHealth, useOpenTasks } from '../lib/queries.ts'
import { Tooltip } from './ui.tsx'
import { cx } from '../lib/tone.ts'

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
  const location = useLocation()
  // The drawer remembers the page it was opened on, so navigating closes it.
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawer = drawerPath === location.pathname
  const setDrawer = (open: boolean) => setDrawerPath(open ? location.pathname : null)
  const tasks = useOpenTasks()
  const dead = useDeadJobs()

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* private mode: not remembered */
    }
  }, [collapsed])

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: NAV.operations,
      items: [
        { to: '/', label: NAV.applications, icon: LayoutList },
        { to: '/review', label: NAV.reviewQueue, icon: ClipboardCheck, count: tasks.data?.count, countTone: 'warning' },
      ],
    },
    {
      title: NAV.merchant,
      items: [
        { to: '/submit', label: NAV.submit, icon: FilePlus2 },
        { to: '/scenarios', label: NAV.scenarios, icon: ListChecks },
      ],
    },
    {
      title: NAV.admin,
      items: [
        { to: '/dead-letters', label: NAV.deadLetters, icon: ArchiveX, count: dead.data?.count, countTone: 'danger' },
        { to: '/demo', label: NAV.demo, icon: FlaskConical },
      ],
    },
  ]

  return (
    <div className="min-h-screen lg:flex lg:bg-accent-700">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow-overlay">
        {NAV.skip}
      </a>

      {drawer && <div className="fixed inset-0 z-40 bg-accent-900/40 lg:hidden" aria-hidden onClick={() => setDrawer(false)} />}

      <aside
        aria-label={NAV.mainNavigation}
        onKeyDown={(e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)}
        className={cx(
          'chrome fixed inset-y-0 left-0 z-50 flex flex-col bg-accent-700 text-accent-100 transition-[width,transform] duration-200',
          'lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          drawer ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'w-64 lg:w-16' : 'w-64',
        )}
      >
        <div className={cx('flex h-14 items-center gap-2.5 border-b border-accent-600 px-4', collapsed && 'lg:justify-center lg:px-0')}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight-400 text-accent-700">
            <ShieldCheck aria-hidden className="size-4.5" />
          </span>
          <div className={cx('min-w-0 leading-tight', collapsed && 'lg:hidden')}>
            <div className="truncate font-display text-sm font-semibold text-white">{PRODUCT.name}</div>
            <div className="text-2xs text-accent-200">{PRODUCT.tagline}</div>
          </div>
          <button type="button" className="ml-auto rounded p-1 text-accent-200 hover:bg-accent-600 lg:hidden" aria-label={NAV.close} onClick={() => setDrawer(false)}>
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {groups.map((g) => (
            <div key={g.title}>
              <div className={cx('mb-1.5 px-3 text-2xs font-bold tracking-wider text-accent-200 uppercase', collapsed && 'lg:sr-only')}>{g.title}</div>
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
          className="hidden items-center gap-2 border-t border-accent-600 px-5 py-3 text-xs text-accent-200 hover:bg-accent-600 hover:text-white lg:flex"
          aria-label={collapsed ? NAV.expand : NAV.collapse}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
          <span className={cx(collapsed && 'lg:sr-only')}>{NAV.collapseShort}</span>
        </button>
      </aside>

      <div className="min-h-screen min-w-0 flex-1 bg-neutral-50">
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
          'group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors',
          "before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-full before:content-['']",
          isActive ? 'bg-accent-600 text-white before:bg-highlight-400' : 'text-accent-100 before:bg-transparent hover:bg-accent-600 hover:text-white',
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
            item.countTone === 'danger' ? 'bg-danger-600' : 'bg-highlight-400 text-accent-700',
            collapsed && 'lg:absolute lg:top-0 lg:right-0 lg:min-w-4 lg:px-1',
          )}
          aria-label={NAV.openCount(item.count)}
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
    <header className="chrome sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-accent-600 bg-accent-700 px-4 sm:px-6 lg:px-8">
      <button type="button" onClick={onMenu} className="rounded p-1.5 text-accent-100 hover:bg-accent-600 lg:hidden" aria-label={NAV.open}>
        <Menu aria-hidden className="size-5" />
      </button>
      <div className="min-w-0 flex-1 truncate text-sm font-bold text-white" aria-live="polite">
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
  const text = state === 'up' ? HEALTH.up : state === 'down' ? HEALTH.down : HEALTH.checking
  return (
    <Tooltip content={text} side="bottom">
      <span tabIndex={0} role="status" aria-label={text} className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-xs text-accent-100">
        <span className={cx('size-2.5 rounded-full', state === 'up' ? 'bg-highlight-400' : state === 'down' ? 'bg-danger-500' : 'bg-accent-300')} />
        <span className="hidden xl:inline">{text}</span>
      </span>
    </Tooltip>
  )
}


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
      else if (APPLICATION_ID_RE.test(q.trim())) go(q.trim())
    } else if (e.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    }
  }

  return (
    <div className="relative w-40 sm:w-72">
      <label htmlFor="global-search" className="sr-only">
        {SEARCH.label}
      </label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-accent-200" />
      <input
        ref={input}
        id="global-search"
        type="search"
        role="combobox"
        aria-expanded={open && q !== ''}
        aria-controls="global-search-results"
        aria-activedescendant={results[active] ? `gs-${results[active].id}` : undefined}
        autoComplete="off"
        placeholder={SEARCH.placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-control border border-accent-500 bg-accent-600 pr-10 pl-8 text-sm text-white placeholder:text-accent-200 focus:border-highlight-400 focus:ring-2 focus:ring-highlight-400/40 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-accent-500 px-1 text-2xs text-accent-200 sm:block">/</kbd>
      {open && q.trim() !== '' && (
        <ul id="global-search-results" role="listbox" className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-auto rounded-card border border-neutral-200 bg-white py-1 shadow-overlay">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">{APPLICATION_ID_RE.test(q.trim()) ? SEARCH.openId : SEARCH.none}</li>
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
                className={cx('cursor-pointer px-3 py-2', i === active && 'bg-neutral-100')}
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
