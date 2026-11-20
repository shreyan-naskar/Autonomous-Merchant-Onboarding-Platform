import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockApp } from './app.js';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PORT = Number(process.env.MOCK_PROVIDERS_PORT ?? 4000);

createMockApp().listen(PORT, () => {
  console.log(`Mock providers running at http://localhost:${PORT}`);
});
