# Getting Started

This tutorial guides you through setting up and running a local Tierwyn development environment from scratch. By the end of this guide, both the backend server and the web interface will be running and communicating on your machine.

---

## Prerequisites

Before starting, ensure you have the following installed on your system:

- **Node.js**: 24 LTS recommended (22.13 minimum); verify with `node -v`
- **npm**: Version 10 or newer (verify with `npm -v`)
- **Git**: For source control checkout

---

## 1. Install Dependencies

From the repository root, install all monorepo workspace dependencies:

```bash
npm install
```

---

## 2. Build the Shared Contract Package

Tierwyn is organized as an npm workspace. The frontend (`apps/web`) and backend (`apps/server`) communicate through types and protocols defined in `packages/shared`. Build the shared package first:

```bash
npm run build --workspace=packages/shared
```

---

## 3. Configure Local Environment

Copy the example environment configuration file into `.env`:

```bash
cp .env.example .env
```

For local development, edit `.env` and set `AUTH_DISABLED=true` to allow direct local access without password hashing, or generate the required `SESSION_SECRET` and `OPERATOR_PASSWORD_HASH` values as described in `.env.example`.

---

## 4. Start the Development Servers

Start both the backend server and frontend development server concurrently:

```bash
npm run dev
```

This launches:
- **Backend API & WebSocket Server**: `http://127.0.0.1:8787`
- **Frontend Vite Dev Server**: `http://127.0.0.1:5173`

---

## 5. Open Tierwyn in Your Browser

Navigate to:

```text
http://127.0.0.1:5173
```

The web client will load and establish a WebSocket connection to the backend server at `http://127.0.0.1:8787`. You are now ready to create conversations and drive local AI coding agents.

This path is a **dev checkout**: agents may edit the repo. To run a hub as a separate Unix user that agents cannot rewrite, see [Dedicated hub user](../deploy/hub-user.md).
