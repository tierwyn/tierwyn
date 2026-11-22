# Run the Test Suite and Type Checks

This guide explains how to run automated tests and TypeScript validation across all Tierwyn workspaces.

---

## 1. Run Workspace Test Suites

Tierwyn uses [Vitest](https://vitest.dev/) for unit and integration testing across packages.

### Run Backend Server Tests

To execute tests for the Express server, database queries, migration engine, and agent adapters:

```bash
npm run test --workspace=apps/server
```

### Run Frontend Client Tests

To execute tests for React components, state hooks, and UI utilities:

```bash
npm run test --workspace=apps/web
```

### Run Shared Contract Tests

To execute tests for shared types, protocols, and event normalizers:

```bash
npm run test --workspace=packages/shared
```

---

## 2. Run Tests in Watch Mode

During active development, start Vitest in interactive watch mode to automatically rerun tests on file changes:

```bash
npm run test:watch --workspace=apps/server
```

---

## 3. Run TypeScript Type Checks

To verify TypeScript types across all workspaces (`packages/shared`, `apps/server`, and `apps/web`) without emitting build files:

```bash
npm run typecheck
```
