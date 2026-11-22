/**
 * `npm run demo`: happy path to a merchant ID, one redelivered callback,
 * gst-fail to review and rejection, audit trails, and a scan of the API log
 * for raw PAN / account values. Exits non-zero if any check fails.
 *
 * Starts its own services on a fresh api/data/demo.db, or reuses running ones
 * and DELETES their data (--external / --spawn force one or the other).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApplicationDetailDto } from '@app/shared';

const ROOT = resolve(__dirname, '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const API_URL = process.env.DEMO_API_URL ?? `http://localhost:${process.env.API_PORT ?? process.env.PORT ?? 3000}`;
const MOCK_URL = process.env.DEMO_MOCK_URL ?? `http://localhost:${process.env.MOCK_PROVIDERS_PORT ?? 4000}`;
const DATA_DIR = join(ROOT, 'api', 'data');
const DEMO_DB = join(DATA_DIR, 'demo.db');
const API_LOG = join(DATA_DIR, 'demo-api.log');
const MOCK_LOG = join(DATA_DIR, 'demo-mock.log');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

const sample = (name: string) => JSON.parse(readFileSync(join(ROOT, 'sample-data', name), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = process.stdout.isTTY
  ? { bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m` }
  : { bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s, red: (s: string) => s };

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? c.green('PASS') : c.red('FAIL')} ${label}`);
  if (!ok) failures++;
}
const step = (n: number, title: string) => console.log(`\n${c.bold(`${n}. ${title}`)}`);

function table(rows: Record<string, string>[], columns: string[]) {
  const width = columns.map((col) => Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)));
  const line = (cells: string[]) => '  ' + cells.map((cell, i) => cell.padEnd(width[i]!)).join('  ');
  console.log(c.bold(line(columns)));
  console.log(line(width.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(columns.map((col) => r[col] ?? '')));
}

const clip = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function compactDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail !== 'object') return String(detail);
  return clip(
    Object.entries(detail as Record<string, unknown>)
      // Correlation ids are noise in a table; the callbacks table shows event ids.
      .filter(([k]) => k !== 'request_id' && k !== 'event_id')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' '),
  );
}

function printTrail(d: ApplicationDetailDto) {
  console.log(
    `\n  ${c.bold(d.merchant_name)}  ${c.dim(d.id)}\n  status ${c.bold(d.status)}  PAN ${d.pan}  GSTIN ${d.gst}  account ${d.bank_account}  IFSC ${d.ifsc}  MID ${d.merchant_id ?? '-'}\n`,
  );
  const t0 = Date.parse(d.audit_log[0]!.at);
  table(
    d.audit_log.map((a, i) => ({
      '#': String(i + 1),
      '+s': ((Date.parse(a.at) - t0) / 1000).toFixed(1),
      actor: a.actor,
      transition: a.to_state ? `${a.from_state ?? '·'} -> ${a.to_state}` : '',
      event: a.event,
      detail: compactDetail(a.detail),
    })),
    ['#', '+s', 'actor', 'transition', 'event', 'detail'],
  );
}

async function http<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
const up = (base: string) =>
  fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })
    .then((r) => r.ok)
    .catch(() => false);

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

const detail = async (id: string) => (await http<ApplicationDetailDto>(API_URL, `/applications/${id}`)).body;

async function follow(id: string, target: string, timeoutMs = 60_000): Promise<ApplicationDetailDto> {
  const seen: string[] = [];
  const start = Date.now();
  for (;;) {
    const d = await detail(id);
    const states = d.audit_log.filter((a) => a.to_state).map((a) => a.to_state!);
    for (const s of states.slice(seen.length)) {
      seen.push(s);
      console.log(`  ${c.dim(`+${((Date.now() - start) / 1000).toFixed(1)}s`)} ${s}`);
    }
    if (d.status === target || Date.now() - start > timeoutMs) return d;
    await sleep(300);
  }
}

const children: ChildProcess[] = [];
function startService(name: string, cwd: string, env: Record<string, string>, logPath: string) {
  const log = createWriteStream(logPath);
  const child = spawn(TSX, ['src/index.ts'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(c.red(`  ${name} exited unexpectedly (code ${code}, signal ${signal}); see ${logPath}`));
  });
  children.push(child);
}
let stopping = false;
async function stopServices() {
  stopping = true;
  await Promise.all(
    children.map(
      (ch) =>
        new Promise<void>((r) => {
          if (ch.exitCode !== null) return r();
          ch.once('exit', () => r());
          ch.kill('SIGTERM');
          setTimeout(() => (ch.kill('SIGKILL'), r()), 5_000).unref();
        }),
    ),
  );
}

async function prepare(): Promise<'spawned' | 'external'> {
  const flags = new Set(process.argv.slice(2));
  const [apiUp, mockUp] = await Promise.all([up(API_URL), up(MOCK_URL)]);

  if (!flags.has('--spawn') && apiUp && mockUp) {
    console.log(`  using running services: API ${API_URL}, mock providers ${MOCK_URL}`);
    const reset = await http<{ deleted: Record<string, number> }>(API_URL, '/admin/reset-data', { method: 'POST' });
    if (reset.status !== 200) throw new Error(`POST /admin/reset-data answered ${reset.status}: is DEMO_MODE off?`);
    await http(MOCK_URL, '/admin/reset', { method: 'POST' });
    console.log(`  data reset (${reset.body.deleted.applications} applications deleted); mock chaos reset`);
    return 'external';
  }
  if (flags.has('--external')) throw new Error(`--external: services not running (API up: ${apiUp}, mock up: ${mockUp})`);
  if (apiUp || mockUp) {
    throw new Error(
      `only one service is running (API up: ${apiUp}, mock up: ${mockUp}). Start both (npm run dev) or stop both and let the demo start them.`,
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  for (const f of [DEMO_DB, `${DEMO_DB}-wal`, `${DEMO_DB}-shm`]) rmSync(f, { force: true });
  console.log(`  starting API and mock providers with a fresh DB (${join('api', 'data', 'demo.db')})`);
  startService('API', join(ROOT, 'api'), { DB_PATH: DEMO_DB, DEMO_MODE: 'true', LOG_LEVEL: 'debug' }, API_LOG);
  startService('mock providers', join(ROOT, 'mock-providers'), {}, MOCK_LOG);
  await waitFor('services to start', async () => (await up(API_URL)) && (await up(MOCK_URL)), 30_000);
  console.log(`  up: API ${API_URL}, mock providers ${MOCK_URL}; logs in api/data/demo-api.log, demo-mock.log`);
  return 'spawned';
}

async function main() {
  console.log(c.bold('Merchant onboarding demo'));
  step(1, 'Reset and services');
  const mode = await prepare();

  step(2, 'Happy path: submit happy.json');
  const happy = sample('happy.json');
  const happyRes = await http<ApplicationDetailDto>(API_URL, '/applications', { method: 'POST', body: happy });
  check(happyRes.status === 201, `POST /applications -> ${happyRes.status}`);
  const happyId = happyRes.body.id;
  let h = await follow(happyId, 'MERCHANT_CREATED');
  check(h.status === 'MERCHANT_CREATED', `reached MERCHANT_CREATED (is ${h.status})`);
  check(/^MID-[A-Z0-9]{8}$/.test(h.merchant_id ?? ''), `merchant ID issued: ${h.merchant_id}`);
  check(h.extracted_fields.every((f) => f.validation_status === 'ok'), `${h.extracted_fields.length} extracted fields, all ok`);
  check(h.verifications.filter((v) => v.is_current).every((v) => v.status === 'PASSED'), 'PAN, GST, BANK, RISK all PASSED');

  step(3, 'Duplicate callback: the mock provider redelivers one callback');
  const original = h.callbacks.find((cb) => !cb.is_duplicate)!;
  const resultsBefore = h.audit_log.filter((a) => a.event === 'VERIFICATION_RESULT').length;
  const redeliver = await http<{ kind: string; api_status: number; api_response: { status: string } }>(MOCK_URL, '/admin/redeliver', {
    method: 'POST',
    body: { event_id: original.event_id },
  });
  console.log(`  redelivered ${redeliver.body.kind} event ${original.event_id}: API answered ${redeliver.body.api_status} ${JSON.stringify(redeliver.body.api_response)}`);
  check(redeliver.body.api_status === 200 && redeliver.body.api_response?.status === 'duplicate', 'API acknowledged it as a duplicate (200)');
  h = await detail(happyId);
  check(h.audit_log.filter((a) => a.event === 'VERIFICATION_RESULT').length === resultsBefore, 'no second VERIFICATION_RESULT: the duplicate had no effect');
  check(h.status === 'MERCHANT_CREATED', 'status unchanged');
  table(
    h.callbacks.map((cb) => ({ kind: cb.kind ?? '', event_id: cb.event_id, duplicate: cb.is_duplicate ? 'yes' : '', outcome: cb.note ?? '' })),
    ['kind', 'event_id', 'duplicate', 'outcome'],
  );

  step(4, 'Exception path: submit gst-fail.json (GST provider fails it)');
  const gstRes = await http<ApplicationDetailDto>(API_URL, '/applications', { method: 'POST', body: sample('gst-fail.json') });
  check(gstRes.status === 201, `POST /applications -> ${gstRes.status}`);
  const gstId = gstRes.body.id;
  let g = await follow(gstId, 'IN_REVIEW');
  const task = g.review_tasks.find((t) => t.status === 'OPEN');
  check(g.status === 'IN_REVIEW', `reached IN_REVIEW (is ${g.status})`);
  check(task?.reason === 'PAN_OK_GST_FAILED', `review task ${task?.reason}: ${task?.note ?? ''}`);
  // Late callbacks may still be landing; give the remaining checks a moment.
  await waitFor('all four results', async () => (await detail(gstId)).verifications.every((v) => v.status !== 'PENDING'), 15_000);

  const note = 'GST registration could not be verified by the provider; rejecting.';
  const tooShort = await http(API_URL, `/applications/${gstId}/review`, { method: 'POST', body: { taskId: task!.id, resolution: 'REJECT', note: 'no' } });
  check(tooShort.status === 400, `operator reject without a proper note -> ${tooShort.status}`);
  const reject = await http<ApplicationDetailDto>(API_URL, `/applications/${gstId}/review`, {
    method: 'POST',
    body: { taskId: task!.id, resolution: 'REJECT', note },
  });
  check(reject.status === 200 && reject.body.status === 'REJECTED', `operator REJECT with note -> ${reject.status} ${reject.body.status}`);
  g = await detail(gstId);

  step(5, 'Audit trails (values masked by the API)');
  printTrail(h);
  printTrail(g);

  const metrics = (await http<{ total_applications: number; exception_rate: number }>(API_URL, '/metrics')).body;
  console.log(`\n  metrics: ${metrics.total_applications} applications, exception rate ${metrics.exception_rate}`);

  if (mode === 'spawned') {
    step(6, 'Log check: no raw PAN / GSTIN / bank account in the API log');
    await sleep(200);
    const log = readFileSync(API_LOG, 'utf8');
    const raw = [happy, sample('gst-fail.json')].flatMap((s) => [s.pan, s.gst, s.bank_account]);
    const leaked = raw.filter((v) => log.includes(v));
    check(leaked.length === 0, `${log.split('\n').length - 1} log lines scanned, ${leaked.length} raw values found`);
  }

  console.log(failures === 0 ? c.green(c.bold('\nDemo passed.')) : c.red(c.bold(`\nDemo FAILED: ${failures} check(s).`)));
}

main()
  .catch((err: unknown) => {
    failures++;
    console.error(c.red(`\nDemo aborted: ${err instanceof Error ? err.message : String(err)}`));
  })
  .finally(async () => {
    await stopServices();
    process.exit(failures === 0 ? 0 : 1);
  });
