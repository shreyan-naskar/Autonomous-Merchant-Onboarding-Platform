import { MerchantServiceConfigSchema } from '@app/shared';
import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { resetAllData } from '../../db/reset.js';
import type { Logger } from '../../logger.js';
import type { SimulatedMerchantService } from '../../merchant/service.js';

/** Demo controls. No auth: dev only. */
export function adminRouter({
  db,
  demoMode,
  merchantService,
  logger,
}: {
  db: Db;
  demoMode: boolean;
  merchantService: SimulatedMerchantService;
  logger: Logger;
}): Router {
  const router = Router();
  /** Exists only when DEMO_MODE is on (404 otherwise). Uploaded files stay on disk. */
  router.post('/reset-data', (_req, res) => {
    if (!demoMode) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    const deleted = resetAllData(db);
    merchantService.fail = false;
    logger.warn({ deleted }, 'demo reset: all data deleted');
    res.json({ deleted });
  });
  router.get('/merchant-service', (_req, res) => {
    res.json({ fail: merchantService.fail });
  });
  router.post('/merchant-service', (req, res) => {
    const { fail } = MerchantServiceConfigSchema.parse(req.body);
    merchantService.fail = fail;
    logger.warn({ fail }, 'merchant service failure flag set');
    res.json({ fail: merchantService.fail });
  });
  return router;
}
