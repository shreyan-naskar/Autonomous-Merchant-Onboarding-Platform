import { MerchantServiceConfigSchema } from '@app/shared';
import { Router } from 'express';
import type { Logger } from '../../logger.js';
import type { SimulatedMerchantService } from '../../merchant/service.js';

/**
 * Demo controls for the API's simulated internal services (the mock
 * providers have their own /admin/config on port 4000). No auth: dev only.
 */
export function adminRouter({ merchantService, logger }: { merchantService: SimulatedMerchantService; logger: Logger }): Router {
  const router = Router();
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
