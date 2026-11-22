// @vitest-environment node
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { userText } from './test/source-text.ts'

/*
 * No coaching words in anything a user reads. Scans the string
 * literals and JSX text (never code or comments) of the web copy, pages and
 * components, the shared label files, and the API's source (whose
 * user-facing literals are review notes and merchant requests).
 */

const BANNED = /\b(try|make sure|you can|we will|we'll|don't worry|usually|watch|look for)\b/i

/** Exact strings allowed to contain a banned word, with the reason. */
const ALLOWED = new Map<string, string>([
  // None yet. "Retry" is not matched (\btry\b), so the Retry button needs no entry.
])

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path, ext))
    else if (ext.test(name) && !/\.test\.|testkit|testing\./.test(name)) out.push(path)
  }
  return out
}

const SCANNED = [
  join(ROOT, 'web/src/copy.ts'),
  ...files(join(ROOT, 'web/src/pages'), /\.tsx?$/),
  ...files(join(ROOT, 'web/src/components'), /\.tsx?$/),
  ...files(join(ROOT, 'web/src/lib'), /\.tsx?$/),
  join(ROOT, 'shared/src/labels.ts'),
  join(ROOT, 'shared/src/review.ts'),
  join(ROOT, 'shared/src/correction.ts'),
  join(ROOT, 'shared/src/intake.ts'),
  ...files(join(ROOT, 'api/src'), /\.ts$/),
]

describe('copy standard', () => {
  it('the tokenizer reads literals and JSX text, not code or comments', () => {
    const src = "// try this\ntry { x('Make sure') } catch {}\nconst a = `ok ${try_} watch`\nconst el = <p>You can look for it</p>"
    expect(userText(src)).toEqual(['Make sure', 'ok   watch', 'You can look for it'])
  })

  it.each(SCANNED.map((f) => [relative(ROOT, f), f]))('%s has no coaching words', (_, file) => {
    const hits = userText(readFileSync(file, 'utf8')).filter((s) => BANNED.test(s) && !ALLOWED.has(s))
    expect(hits).toEqual([])
  })
})
