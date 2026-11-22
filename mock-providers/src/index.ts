import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockApp } from './app.js';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const env = process.env;
const PORT = Number(env.MOCK_PROVIDERS_PORT ?? 4000);
const webhookUrl = env.WEBHOOK_URL ?? 'http://localhost:3000/webhooks/provider';
// Same names (and dev default) as the API's config.
const hmacSecret = env.HMAC_SECRET || env.WEBHOOK_SECRET || 'dev-only-hmac-secret-change-me';
const delayMs = env.MOCK_DELAY_MS ? Number(env.MOCK_DELAY_MS) : undefined;

const app = createMockApp({
  webhookUrl,
  hmacSecret,
  chaos: delayMs !== undefined ? { delayMs } : {},
  onDelivery: (d) => console.log(`callback ${d.kind} ${d.event_id} -> ${d.status ?? d.error}`),
});

app.listen(PORT, () => {
  console.log(`Mock providers running at http://localhost:${PORT} (callbacks to ${webhookUrl})`);
});
