/* Reading user-visible text out of TS/TSX source, for copy.test.ts and contrast.test.ts. */

/** String literals and JSX text of a TS/TSX file. A small tokenizer: comments are skipped, template `${}` parts are code. */
export function userText(source: string): string[] {
  const out: string[] = []
  let code = ''
  let i = 0
  const flushCode = () => {
    for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]!.trim())
    code = ''
  }
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2)
      i = i < 0 ? source.length : i + 2
    } else if (c === "'" || c === '"' || c === '`') {
      flushCode()
      let s = ''
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          s += source[i + 1] ?? ''
          i += 2
        } else if (c === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 1
          i += 2
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++
            else if (source[i] === '}') depth--
            i++
          }
          s += ' '
        } else {
          s += source[i]
          i++
        }
      }
      i++
      out.push(s)
    } else {
      code += c
      i++
    }
  }
  flushCode()
  return out.filter((s) => /[A-Za-z]{2}/.test(s))
}
