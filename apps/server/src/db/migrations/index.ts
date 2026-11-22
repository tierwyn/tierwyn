import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Migration } from '../migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 001_baseline.sql is the whole schema. Every pre-release migration (legacy
 * 001-042, 100-156) was squashed into it at release; their SQL lives in git
 * history. Existing installs were restamped to schema_migrations = {1}.
 * The next new migration must be **2**.
 */
export const migrations: Migration[] = [
  { version: 1, sql: readFileSync(join(here, '001_baseline.sql'), 'utf-8') },
];
