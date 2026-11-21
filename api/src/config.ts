import { z } from 'zod';

/** Dev-only secret; real deployments must set HMAC_SECRET from a secrets manager. */
export const DEV_HMAC_SECRET = 'dev-only-hmac-secret-change-me';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DB_PATH: z.string().min(1).default('./data/app.db'),
  UPLOAD_DIR: z.string().min(1).default('./uploads'),
  WEBHOOK_URL: z.url().default('http://localhost:3000/webhooks/provider'),
  MOCK_PROVIDER_URL: z.url().default('http://localhost:4000'),
  HMAC_SECRET: z.string().min(1).default(DEV_HMAC_SECRET),
  DEMO_MODE: z.stringbool().default(true),
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  RISK_THRESHOLD: z.coerce.number().min(0).max(100).default(70),
  NAME_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  // Laplacian variance. Calibrated on sample-data/pan-sharp.png (~990) vs pan-blurry.png (~1.7).
  BLUR_THRESHOLD: z.coerce.number().min(0).default(30),
  OCR_CACHE_DIR: z.string().min(1).default('./.ocr-cache'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = ReturnType<typeof loadConfig>;

type Env = Record<string, string | undefined>;

/** Names used by the original .env, mapped onto the canonical names. */
const ALIASES: Record<string, string> = {
  API_PORT: 'PORT',
  PROVIDER_BASE_URL: 'MOCK_PROVIDER_URL',
  WEBHOOK_SECRET: 'HMAC_SECRET',
};

function applyAliases(env: Env): Env {
  const out: Env = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    if (env[key] !== undefined && env[key] !== '') out[key] = env[key];
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (out[canonical] === undefined && env[alias] !== undefined && env[alias] !== '') {
      out[canonical] = env[alias];
    }
  }
  return out;
}

/** Pure (no process access), so tests can build any config. */
export function loadConfig(env: Env = process.env) {
  const e = EnvSchema.parse(applyAliases(env));
  const demo = e.DEMO_MODE;
  return {
    port: e.PORT,
    dbPath: e.DB_PATH,
    uploadDir: e.UPLOAD_DIR,
    webhookUrl: e.WEBHOOK_URL,
    mockProviderUrl: e.MOCK_PROVIDER_URL,
    hmacSecret: e.HMAC_SECRET,
    demoMode: demo,
    logLevel: e.LOG_LEVEL,
    thresholds: {
      confidence: e.CONFIDENCE_THRESHOLD,
      risk: e.RISK_THRESHOLD,
      nameMatch: e.NAME_MATCH_THRESHOLD,
      blur: e.BLUR_THRESHOLD,
    },
    ocrCacheDir: e.OCR_CACHE_DIR,
    timings: {
      verificationTimeoutMs: demo ? 30_000 : 15 * 60_000,
      backoffBaseMs: demo ? 1_000 : 60_000,
      workerPollMs: demo ? 500 : 2_000,
    },
    limits: {
      jobMaxAttempts: 5,
      verificationMaxRetries: 2,
      merchantCreateMaxAttempts: 3,
    },
  } as const;
}
