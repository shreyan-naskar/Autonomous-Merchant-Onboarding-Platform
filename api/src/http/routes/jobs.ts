import { RequeueJobRequestSchema } from '@app/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { listDeadJobs, requeueJob } from '../../jobs/deadLetter.js';
import type { Logger } from '../../logger.js';
import { toDeadJobDto } from '../dto.js';

const ListQuerySchema = z.object({
  status: z.literal('dead').default('dead'),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const IdSchema = z.coerce.number().int().positive();

/** Only dead jobs are exposed. Requeueing needs a note, like every operator action. */
export function jobsRouter({ db, logger, now }: { db: Db; logger: Logger; now: () => number }): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const q = ListQuerySchema.parse(req.query);
    const items = listDeadJobs(db, { limit: q.limit }).map(toDeadJobDto);
    res.json({ items, count: items.length });
  });
  router.post('/:id/requeue', (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const { note } = RequeueJobRequestSchema.parse(req.body ?? {});
    const job = requeueJob(db, id, { now: now(), note });
    logger.info({ job_id: job.id, type: job.type }, 'dead job requeued');
    res.json(toDeadJobDto(job));
  });
  return router;
}
