# Deploy Tierwyn to Production

This guide covers building production artifacts, managing systemd user service units, and deploying updates to a live Tierwyn production instance **on the same host as this checkout** (`tierwyn-prod*`). Agents on that box may edit the repo.

A **dedicated hub user** (separate Unix account, `tierwyn-hub*`, agents cannot rewrite the install) is a different install: [Dedicated hub user](../deploy/hub-user.md).

---

## 1. Production Environment Layout

Production runs alongside development on the same host using distinct ports, database files, and environment configuration:

| Component | Development | Production |
|---|---|---|
| Environment File | `.env` (repo root) | `/etc/tierwyn/prod.env` (permissions `600`, owned by operator UID) |
| API / WebSocket Port | `8787` (`127.0.0.1:8787`) | `8788` (`127.0.0.1:8788`) |
| Web Frontend | Vite dev server (`5173`) | Vite preview server (`4173`, `--host 0.0.0.0`) |
| Database Path | `./data/tierwyn.db` (default, or `TIERWYN_DB`) | `./data/prod.db` |
| Process Supervisor | Terminal session | `tierwyn-prod.service` + `tierwyn-prod-web.service` (systemd user units) |

---

## 2. Prepare the Production Environment File

Create `/etc/tierwyn/prod.env` with restricted permissions:

```bash
sudo mkdir -p /etc/tierwyn
sudo touch /etc/tierwyn/prod.env
sudo chown $(id -un):$(id -gn) /etc/tierwyn/prod.env
chmod 600 /etc/tierwyn/prod.env
```

Configure the production environment variables in `/etc/tierwyn/prod.env`:

```ini
PORT=8788
HOST=127.0.0.1
TIERWYN_DB=./data/prod.db
AUTH_DISABLED=false
COOKIE_SECURE=true
TRUST_PROXY=loopback   # proxy on another host: loopback,<proxy-ip> (never a hop count)
OPERATOR_PASSWORD_HASH=<argon2-hash>
SESSION_SECRET=<random-32-byte-base64-secret>
```

> **Security Note:** Never set `AUTH_DISABLED=true` in production. Always keep `HOST=127.0.0.1` for the backend API.

After moving a provider key (`OPENAI_API_KEY`, `ZAI_API_KEY`, …) into **Settings → Agents → Environment**, delete it from `/etc/tierwyn/prod.env` and restart prod. Managed-name scrub already strips it from agent children; restarting drops it from the server process itself.

---

## 3. Install Systemd User Units

Copy systemd unit templates to your user systemd directory:

```bash
mkdir -p ~/.config/systemd/user
cp docs/deploy/systemd/tierwyn-prod.service ~/.config/systemd/user/
cp docs/deploy/systemd/tierwyn-prod-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable tierwyn-prod.service tierwyn-prod-web.service
```

---

## 4. Execute Full Production Deploy

To build all workspaces (`packages/shared`, `apps/server`, and `apps/web`) and restart both production services:

```bash
npm run deploy:prod:full
```

---

## 5. Execute Web-Only Deploy

When you have only changed frontend assets in `apps/web`:

```bash
npm run deploy:prod
```

---

## 6. Verify Service Status

Check that both user units are active and running:

```bash
systemctl --user status tierwyn-prod.service tierwyn-prod-web.service
```

Verify that the backend API is listening on loopback port 8788:

```bash
ss -tlnp | grep 8788
```
