# Build Monorepo Workspaces and Manage Shared Contracts

This guide explains how to compile monorepo workspaces, enforce build order, and propagate changes across `@tierwyn/shared`, `@tierwyn/server`, and `@tierwyn/web`.

---

## 1. Understand Workspace Dependencies

Tierwyn is structured as an npm monorepo with three primary packages:

| Workspace | Package Name | Role | Depends On |
|---|---|---|---|
| `packages/shared` | `@tierwyn/shared` | Contract boundary: events, protocol frames, domain models | None |
| `apps/server` | `@tierwyn/server` | Express API + WebSocket backend | `@tierwyn/shared` |
| `apps/web` | `@tierwyn/web` | React + Vite browser client | `@tierwyn/shared` |

Because both `apps/server` and `apps/web` import compiled output from `packages/shared/dist`, `packages/shared` must always be built before running or compiling either application.

---

## 2. Build the Shared Contract Package

When you modify types, event schemas (`packages/shared/src/events.ts`), or protocol frames (`packages/shared/src/protocol.ts`), rebuild the shared package:

```bash
npm run build --workspace=packages/shared
```

During active development across packages, you can keep the shared TypeScript compiler in watch mode:

```bash
npm run dev --workspace=packages/shared
```

---

## 3. Build All Workspaces

To compile all packages in the repository in one command:

```bash
npm run build
```

This runs the workspace-level `build` script across `packages/shared`, `apps/server`, and `apps/web`.

---

## 4. Build Individual Application Bundles

### Server Bundle

To compile the TypeScript server and copy database migrations and voice manifests to `dist/`:

```bash
npm run build --workspace=apps/server
```

### Web Production Bundle

To compile TypeScript and bundle the frontend SPA with Vite into `apps/web/dist/`:

```bash
npm run build --workspace=apps/web
```
