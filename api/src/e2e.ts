import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationDetailDtoSchema, type ApplicationDetailDto, type ChaosConfig } from '@app/shared';
import { createManualScheduler, createMockApp } from 'mock-providers';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { jobs } from './db/schema.js';
import { fakeOcr } from './extraction/testkit.js';
import { createJobHandlers } from './jobs/handlers.js';
import { runDueJobsOnce } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { createSimulatedMerchantService } from './merchant/service.js';
import { createHttpProviderClient } from './providers/client.js';

/* Test harness: API and mock providers on random ports, signed callbacks, the worker on a fake clock, callbacks on virtual time. */

const T0 = 1_700_000_000_000;
const SECRET = 'e2e-secret';

async function listen(app: { listen: (port: number) => Server }): Promise<[Server, string]> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

export async function startE2E({ logStream, logLevel = 'silent' }: { logStream?: DestinationStream; logLevel?: string } = {}) {
  const t = { clock: T0 };
  const db = openDb(':memory:');
  const uploadDir = mkdtempSync(join(tmpdir(), 'e2e-uploads-'));
  const config = loadConfig({ DB_PATH: ':memory:', HMAC_SECRET: SECRET, UPLOAD_DIR: uploadDir });
  const logger = createLogger({ level: logLevel, stream: logStream });
  const merchantService = createSimulatedMerchantService(db);
  const [apiServer, apiUrl] = await listen(createApp({ config, logger, db, now: () => t.clock, merchantService }));
  const sched = createManualScheduler();
  const mock = createMockApp({ webhookUrl: `${apiUrl}/webhooks/provider`, hmacSecret: SECRET, scheduler: sched, chaos: { delayMs: 1_000 } });
  const [mockServer, mockUrl] = await listen(mock);
  const worker = {
    db,
    config,
    logger,
    handlers: createJobHandlers({ providers: createHttpProviderClient({ baseUrl: mockUrl }), merchantService, ocr: fakeOcr() }),
  };

  const api = () => request(apiServer);
  const e2e = {
    t,
    db,
    config,
    secret: SECRET,
    api,
    /** Run queued jobs at their run_at that fall due within `horizon` ms of now (default: not the 30s timeouts). */
    async drain(horizon = 5_000) {
      const until = t.clock + horizon;
      for (let i = 0; i < 200; i++) {
        const next = db
          .select()
          .from(jobs)
          .all()
          .filter((j) => j.status === 'queued' && j.runAt <= until)
          .sort((a, b) => a.runAt - b.runAt)[0];
        if (!next) return;
        t.clock = Math.max(t.clock + 1, next.runAt);
        await runDueJobsOnce(worker, t.clock);
      }
      throw new Error('worker did not go idle');
    },
    /** Deliver mock callbacks due within `ms` of virtual time; returns the number of scheduled events. */
    deliver: (ms = 1_000) => sched.advance(ms),
    setChaos: (patch: Partial<ChaosConfig>) => request(mockUrl).post('/admin/config').send(patch).expect(200),
    async submit(body: unknown): Promise<string> {
      const res = await api().post('/applications').send(body as object);
      expect(res.status).toBe(201);
      return res.body.id as string;
    },
    async detail(id: string): Promise<ApplicationDetailDto> {
      const res = await api().get(`/applications/${id}`);
      expect(res.status).toBe(200);
      return ApplicationDetailDtoSchema.parse(res.body);
    },
    review: (id: string, taskId: number, resolution: string, note = 'checked by ops') =>
      api().post(`/applications/${id}/review`).send({ taskId, resolution, note }),
    async close() {
      await Promise.all([apiServer, mockServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
      db.$client.close();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
  return e2e;
}
export type E2E = Awaited<ReturnType<typeof startE2E>>;

export const openTask = (d: ApplicationDetailDto, reason: string) => d.review_tasks.find((x) => x.reason === reason && x.status === 'OPEN')!;
export const events = (d: ApplicationDetailDto, event: string) => d.audit_log.filter((a) => a.event === event);
