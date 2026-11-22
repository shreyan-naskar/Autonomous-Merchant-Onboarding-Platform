// @vitest-environment node
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { userText } from '../test/source-text.ts'
import { duration, plural } from './format.ts'

describe('duration: one format everywhere', () => {
  it.each([
    [0, '0s'],
    [40, '0.1s'],
    [500, '0.5s'],
    [1500, '1.5s'],
    [2000, '2s'],
    [9_940, '9.9s'],
    [9_960, '10s'],
    [45_400, '45s'],
    [60_000, '1m'],
    [134_000, '2m 14s'],
    [7_500_000, '2h 5m'],
    [3_600_000, '1h'],
    [273_600_000, '3d 4h'],
  ])('%i ms -> %s', (ms, text) => {
    expect(duration(ms)).toBe(text)
  })
})

describe('plural', () => {
  it('agrees with the number and groups digits en-IN', () => {
    expect(plural(1, 'exception')).toBe('1 exception')
    expect(plural(0, 'exception')).toBe('0 exceptions')
    expect(plural(100000, 'attempt')).toBe('1,00,000 attempts')
  })
})

const SRC = fileURLToPath(new URL('..', import.meta.url))
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'test' ? [] : files(p)
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : []
  })

describe('no "ms" in UI wording', () => {
  it('no string literal or JSX text formats a duration in milliseconds', () => {
    const hits = files(SRC).flatMap((f) => userText(readFileSync(f, 'utf8')).filter((s) => /(^|[\d\s])ms\b/.test(s)).map((s) => `${f}: ${s}`))
    expect(hits).toEqual([])
  })
})
