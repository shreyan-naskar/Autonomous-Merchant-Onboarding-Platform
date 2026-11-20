import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { listDeadJobs, requeueJob } from '../../jobs/deadLetter.js';
import type { Logger } from '../../logger.js';
import { toDeadJobDto } from '../dto.js';

const ListQuerySchema = z.object({
  // Only the dead-letter view is exposed.
  status: z.literal('dead').default('dead'),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const IdSchema = z.coerce.number().int().positive();

/**
 * Dead-letter view (no auth, like the rest of the demo API):
 * - `GET /jobs?status=dead` dead jobs, newest first, payloads masked.
 * - `POST /jobs/:id/requeue` dead -> queued with attempts reset (409 if not dead).
 */
export function jobsRouter({ db, logger, now }: { db: Db; logger: Logger; now: () => number }): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const q = ListQuerySchema.parse(req.query);
    const items = listDeadJobs(db, { limit: q.limit }).map(toDeadJobDto);
    res.json({ items, count: items.length });
  });
  router.post('/:id/requeue', (req, res) => {
    const job = requeueJob(db, IdSchema.parse(req.params.id), { now: now() });
    logger.info({ job_id: job.id, type: job.type }, 'dead job requeued');
    res.json(toDeadJobDto(job));
  });
  return router;
}
