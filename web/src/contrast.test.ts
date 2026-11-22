// @vitest-environment node
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { userText } from './test/source-text.ts'

/*
 * WCAG AA for every text colour used in a component: each class string's
 * text-* token is checked against the bg-* tokens in the same string (same
 * variant prefix), or, when it sets none, against the surfaces that text
 * sits on (light text on the navy chrome, dark text on the light
 * content area). Text needs 4.5:1; icon-only elements (a size-* class and
 * no text size) need 3:1 (WCAG 1.4.11).
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8')

const TOKENS: Record<string, string> = { white: '#ffffff' }
for (const m of CSS.matchAll(/--color-([a-z]+-\d+):\s*(#[0-9a-f]{6})/gi)) TOKENS[m[1]!] = m[2]!

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1! + 0.05) / (l2! + 0.05)
}

const LIGHT_SURFACES = ['white', 'neutral-50', 'neutral-100']
const DARK_SURFACES = ['accent-700', 'accent-600']
const COLOR = /^(?:text|bg)-((?:[a-z]+-\d+)|white)(?:\/(\d+))?$/

interface Pairing {
  file: string
  text: string
  bg: string
  ratio: number
  min: number
}

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(path)
  }
  return out
}

/** Every text colour in a class string with the backgrounds it is drawn on. */
export function pairings(classes: string, file = ''): Pairing[] {
  const groups = new Map<string, { texts: string[]; bgs: string[] }>()
  for (const cls of classes.split(/\s+/)) {
    const parts = cls.split(':')
    const util = parts.pop()!
    // Responsive prefixes do not change what is drawn where; state prefixes do.
    const prefix = parts.filter((p) => !/^(sm|md|lg|xl|2xl)$/.test(p)).join(':')
    const m = util.match(COLOR)
    if (!m || !(m[1]! in TOKENS)) continue
    if (/(^|:)(placeholder|disabled|before|after)$/.test(prefix) || prefix.startsWith('placeholder')) continue
    const g = groups.get(prefix) ?? { texts: [], bgs: [] }
    if (util.startsWith('text-')) g.texts.push(m[1]!)
    else if (!m[2] || Number(m[2]) >= 50) g.bgs.push(m[1]!)
    groups.set(prefix, g)
  }
  const iconOnly = /(^|\s)size-/.test(classes) && !/(^|\s)(text-(2xs|xs|sm|base|lg|xl|2xl|3xl)|font-)/.test(classes)
  const out: Pairing[] = []
  for (const [prefix, g] of groups) {
    const bgs = g.bgs.length ? g.bgs : (groups.get('')?.bgs ?? [])
    for (const text of g.texts) {
      const surfaces = bgs.length ? bgs : luminance(TOKENS[text]!) > 0.3 ? DARK_SURFACES : LIGHT_SURFACES
      for (const bg of surfaces) {
        if (prefix === '' && bg === text) continue
        out.push({ file, text, bg, ratio: contrast(TOKENS[text]!, TOKENS[bg]!), min: iconOnly ? 3 : 4.5 })
      }
    }
  }
  return out
}

const ALL = files(SRC)
  .filter((f) => !f.includes(`${join(SRC, 'test')}`))
  .flatMap((f) => userText(readFileSync(f, 'utf8')).flatMap((s) => (/(^|\s)(?:[a-z-]+:)*text-/.test(s) ? pairings(s, relative(SRC, f)) : [])))

describe('colour contrast (WCAG AA)', () => {
  it('reads the brand tokens', () => {
    expect(TOKENS['accent-700']).toBe('#003434')
    expect(TOKENS['highlight-400']).toBe('#d0f255')
  })

  it('lime never carries text on white, and navy on lime reads well', () => {
    expect(contrast(TOKENS['highlight-400']!, '#ffffff')).toBeLessThan(4.5)
    expect(pairings('text-highlight-400 bg-white').every((p) => p.ratio < p.min)).toBe(true)
    expect(contrast(TOKENS['accent-700']!, TOKENS['highlight-400']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('pairs text with the background in the same class string, per state prefix', () => {
    expect(pairings('bg-accent-700 text-white hover:bg-accent-600 hover:text-white').map((p) => `${p.text}/${p.bg}`)).toEqual(['white/accent-700', 'white/accent-600'])
  })

  it('finds the text colours used across the app', () => {
    expect(ALL.length).toBeGreaterThan(100)
  })

  it('every text colour pairing used in a component meets AA', () => {
    const failing = ALL.filter((p) => p.ratio < p.min).map((p) => `${p.file}: text-${p.text} on ${p.bg} = ${p.ratio.toFixed(2)} (needs ${p.min})`)
    expect([...new Set(failing)]).toEqual([])
  })
})
