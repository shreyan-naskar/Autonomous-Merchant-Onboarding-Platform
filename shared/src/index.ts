import { z } from 'zod';

export * from './mask.js';
export * from './domain.js';
export * from './intake.js';
export * from './dto.js';
export * from './validators.js';
export * from './providers.js';
export * from './review.js';
export * from './correction.js';
export * from './labels.js';

export const HealthSchema = z.object({
  status: z.string(),
  service: z.string(),
});

export type Health = z.infer<typeof HealthSchema>;
