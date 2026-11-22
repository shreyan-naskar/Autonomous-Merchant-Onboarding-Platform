import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openDb } from './client.js';

// `npm run db:migrate -w api`: apply pending migrations to DB_PATH.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { dbPath } = loadConfig(process.env);
const db = openDb(dbPath);
const tables = db.$client
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];
db.$client.close();
console.log(`Migrated ${resolve(dbPath)}: ${tables.map((t) => t.name).join(', ')}`);
