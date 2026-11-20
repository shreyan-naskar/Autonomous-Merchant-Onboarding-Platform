import { z } from 'zod';

export * from './mask.js';
export * from './domain.js';
export * from './intake.js';
export * from './dto.js';
export * from './validators.js';

export const HealthSchema = z.object({
  status: z.string(),
  service: z.string(),
});

export type Health = z.infer<typeof HealthSchema>;
