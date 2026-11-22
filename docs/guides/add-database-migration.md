# Add a Database Migration

This guide explains how to create, register, and test a new SQLite schema migration in Tierwyn.

---

## 1. Understand Migration Versioning

Tierwyn manages SQLite schema migrations sequentially via `better-sqlite3`. Migrations are recorded in the `schema_migrations` table.

### Versioning Rules

- **Baseline:** `001_baseline.sql` (version 1) is the whole schema and the only registered migration. Every pre-release migration was squashed into it at release; their SQL lives in git history.
- **Next available version:** `2`.

---

## 2. Create the Migration SQL File

Create a new `.sql` file in `apps/server/src/db/migrations/` using the format `<version>_<description>.sql`:

```sql
-- apps/server/src/db/migrations/002_example_feature.sql
ALTER TABLE conversations ADD COLUMN example_field TEXT;
```

---

## 3. Register the Migration

Migrations are not dynamically auto-discovered at runtime. You must register every migration explicitly in `apps/server/src/db/migrations/index.ts`:

```typescript
// apps/server/src/db/migrations/index.ts
export const migrations: Migration[] = [
  { version: 1, sql: readFileSync(join(here, '001_baseline.sql'), 'utf-8') },
  { version: 2, sql: readFileSync(join(here, '002_example_feature.sql'), 'utf-8') },
];
```

---

## 4. Verify and Test Migration Execution

Run the backend test suite to verify migration parsing and database initialization:

```bash
npm run test --workspace=apps/server
```

When the server starts up (in development via `npm run dev:server` or production via `node dist/index.js`), it executes `migrate()` from `apps/server/src/db/migrate.ts`, applying all unapplied registered migrations inside a transaction.
