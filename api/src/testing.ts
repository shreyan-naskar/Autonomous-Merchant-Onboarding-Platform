import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Shared test helpers: sample files and a scan of the API's own source. */

export const SAMPLE_DIR = fileURLToPath(new URL('../../sample-data/', import.meta.url));
export const sample = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));
export const sampleFile = (name: string) => readFileSync(join(SAMPLE_DIR, name));

/** Non-test .ts files under `dir`. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}
