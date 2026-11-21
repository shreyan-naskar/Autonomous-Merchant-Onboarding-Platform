import { ListReviewTasksQuerySchema } from '@app/shared';
import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { listReviewTasks } from '../../domain/queries.js';
import { toReviewQueueItemDto } from '../dto.js';

/** `GET /review-tasks?status=OPEN|RESOLVED` — the operator review queue (read-only; resolve via /applications/:id/review). */
export function reviewTasksRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const q = ListReviewTasksQuerySchema.parse(req.query);
    const items = listReviewTasks(db, q).map(toReviewQueueItemDto);
    res.json({ items, count: items.length });
  });
  return router;
}
