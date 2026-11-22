# Tierwyn: Deployment runbook (LAN + TLS)

This runbook covers exposing Tierwyn securely on your LAN via a reverse proxy
with TLS termination.  Node stays bound to `127.0.0.1` (INV-5); the proxy
is the only public-facing component.

**Related (not covered here):**

| Doc | Topic |
|---|---|
| [operator-sidecars.md](./operator-sidecars.md) | Systemd user units, Piper + **Kokoro** TTS install, sidecar glue (Tierwyn does not autostart helpers). Kokoro runs natively (CPU / CUDA / ROCm venv via `tierwyn sidecars`). |
| [hub-user.md](./hub-user.md) | Dedicated hub user vs this checkout: isolation, `tierwyn hub restart`, install |
| [systemd/](./systemd/) | Versioned unit templates (`tierwyn-prod`, `tierwyn-prod-web`, `tierwyn-piper`, `tierwyn-kokoro`, `tierwyn-node`); hub units are these prod templates with names rewritten |
| [Remote Hosts](../architecture/remote-hosts.md) | `tierwyn node` on another machine (hub package or GitHub git); never restart `tierwyn-prod*` from a node host |
| [piper/server.py](./piper/server.py) | Piper multi-voice Flask wrapper (copy to `~/tierwyn-piper/`) |
| Repo `CLAUDE.md` | Prod gotchas, agent PATH, Piper + Kokoro summaries |

**Installer CLI:** `tierwyn` is a symlink to `scripts/install.sh` (`~/.local/bin/tierwyn`, created at the end of setup). Use `tierwyn setup`, `tierwyn doctor`, `tierwyn restart`, `tierwyn hub restart`, `tierwyn config`, `tierwyn update`, `tierwyn logs`. `curl …/scripts/install.sh | bash` still bootstraps a clone. `npm run tierwyn:*` is unchanged.

A **dedicated hub user** (sandbox on, agents cannot edit the install tree) is a different mode from this checkout. Table, isolation, and install: **[hub-user.md](hub-user.md)**.

---

## 1. Architecture overview

```
Phone / laptop on LAN
        │
        │  HTTPS (TLS terminated here)
        ▼
Reverse proxy: Caddy or nginx
  ├─ optional LAN-subnet allowlist (secondary layer)
  ├─ forwards cookies + X-Forwarded-For
  └─ passes WebSocket upgrade (Connection/Upgrade headers)
        │
        │  http://127.0.0.1:4173  (Vite preview: SPA + proxied API paths)
        ▼
Vite preview  ─►  proxies /auth, /spawn, /ws, … to the API
        │
        │  http://127.0.0.1:8788  (plain HTTP, loopback only)
        ▼
Node backend  ─►  requireAuth middleware  ─►  WS upgrade guard
```

---

## 2. Prerequisites

- A **hostname** with a valid TLS certificate (e.g. a subdomain of your
  personal domain pointed at your home IP, with a Let's Encrypt cert).
  Phone browsers reject `secure` cookies and warn on self-signed certs:
  a real cert is required for the session cookie to work.
- Caddy or nginx installed on the same machine as the Node process.
- The Tierwyn server already running (see §3).

---

## 3. Generate secrets and configure `.env`

### 3a. Hash the operator password

Run from the **repo root** (argon2 is installed in the workspace):

```bash
node -e "require('argon2').hash(process.argv[1]).then(h=>console.log(h))" 'your-operator-password'
```

Example output shape:

```
$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
```

Paste the full `$argon2id$...` string into `.env` as `OPERATOR_PASSWORD_HASH`.
**Do not store the plaintext password anywhere.**

### 3b. Generate a random `SESSION_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# or
openssl rand -base64 32
```

Paste the output into `.env` as `SESSION_SECRET`.

### 3c. Set the remaining auth vars

```ini
# .env (behind a TLS proxy: production settings)
OPERATOR_PASSWORD_HASH=$argon2id$v=19$m=65536,t=3,p=4$...
SESSION_SECRET=<your-random-secret>

# COOKIE_SECURE defaults to true: leave it unset (or set true) here.
# AUTH_DISABLED must be absent or false: see warning below.
# TRUST_PROXY defaults to 'loopback': correct for single-machine setups.
```

> **WARNING: AUTH_DISABLED must be OFF**
> If `AUTH_DISABLED=true` is set in `.env`, authentication is completely
> bypassed and anyone on the network can access the app without a password.
> Only use it for local development on a machine that is not accessible from
> any other device. Remove it or set it to `false` before exposing the app
> on the LAN.
>
> Tierwyn enforces loopback binding safety at startup (`assertAuthBindSafe` in
> `apps/server/src/auth/config.ts`): if `AUTH_DISABLED=true` is set while `HOST`
> binds to any non-loopback interface (such as `0.0.0.0` or a public IP), the
> server refuses to boot:
> `Refusing to start: AUTH_DISABLED=true with HOST=... Bind to 127.0.0.1 or enable auth.`
> The only override is the explicit testing flag `TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL=1`.

### 3d. Outbound network protection and SSRF allowlist (`TIERWYN_OUTBOUND_ALLOW`)

Tierwyn validates outbound destination URLs (`assertOutboundUrl` and `safeFetch` in
`apps/server/src/net/outboundUrl.ts`) to prevent Server-Side Request Forgery (SSRF).

- **Public endpoints** (e.g. web proxy routes and web-push subscriptions) block loopback
  (`127.0.0.0/8`, `::1`), RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`), Carrier-Grade NAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`,
  `fe80::/10`), and IPv6 Unique Local Addresses (`fc00::/7`).
- **All outbound endpoints** (including operator-configured LLM base URLs and TTS sidecars)
  strictly block link-local addresses, cloud metadata endpoints (e.g. AWS IMDS `fd00:ec2::254`,
  Aliyun metadata `100.100.100.200`), multicast/broadcast addresses, and IPv4-mapped or
  IPv4-compatible IPv6 addresses (`::ffff:0:0/96`, `64:ff9b::/96`).

To allow Tierwyn to access specific private IP addresses or internal hostnames, configure a
comma-separated allowlist in `.env` or `/etc/tierwyn/prod.env`:

```ini
TIERWYN_OUTBOUND_ALLOW=192.168.1.50,10.0.0.0/24,sidecar.internal
```

---

## 4. Start the server

```bash
# From the repo root
npm run dev              # development (Vite 5173 + API 8787)
# or (prod user units already installed):
npm run deploy:prod:full # build all workspaces + restart API + web
```

Prod API listens on `http://127.0.0.1:8788` (web preview on `:4173`). Confirm
loopback-only for the API:

```bash
ss -tlnp | grep 8788
# Expected: 127.0.0.1:8788: NOT 0.0.0.0:8788
```

---

## 5. Configure the reverse proxy

### Caddy (recommended: automatic TLS)

Copy `docs/deploy/Caddyfile.example` and replace `commandcentre.example.com`
with your hostname.  Caddy provisions and renews the Let's Encrypt certificate
automatically.

```bash
cp docs/deploy/Caddyfile.example /etc/caddy/Caddyfile
# Edit the hostname
sudo systemctl reload caddy
```

### nginx (manual TLS cert required)

1. Obtain a certificate (e.g. `certbot --nginx -d commandcentre.example.com`).
2. Copy `docs/deploy/nginx.conf.example`, edit the hostname and cert paths,
   and add the `map $http_upgrade $connection_upgrade` block to your
   `http {}` context (e.g. in `/etc/nginx/nginx.conf`).

```bash
cp docs/deploy/nginx.conf.example /etc/nginx/sites-available/tierwyn
ln -s /etc/nginx/sites-available/tierwyn /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### WebSocket upgrade: what the proxy must do

Both sample configs pass the WebSocket upgrade correctly.  The critical
directives are:

| Proxy   | Directive                                               |
|---------|--------------------------------------------------------|
| Caddy   | `header_up Connection {>Connection}` and `header_up Upgrade {>Upgrade}` |
| nginx   | `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection $connection_upgrade;` (with the upgrade map) |

Without these, the proxy strips `Connection: Upgrade` / `Upgrade: websocket`
and the Node server never receives the upgrade request; the WebSocket
connection silently fails.

Vite preview rejects unknown `Host` headers (DNS-rebinding protection). Behind
a reverse proxy the browser sends your public hostname, so the prod-web unit
must set `TIERWYN_ALLOWED_HOSTS` (`true` / `all`, or a comma-separated hostname
list; a value in the unit's EnvironmentFile counts too). Unset, Vite allows
localhost and IPs only and the proxied domain gets "Blocked request".
`true` / `all` disables Host checks (DNS-rebinding risk): Vite logs a warning
at start. `tierwyn update` adds `true` when the installed unit is missing the
variable; `tierwyn config` / `tierwyn services` keep a narrowed value instead of
resetting to the template. Narrow the unit from `true` to your hostname when
you can.

---

## 6. `trust proxy` rationale

The server sets:

```js
const trustProxy = process.env.TRUST_PROXY?.trim();
app.set('trust proxy', !trustProxy ? 'loopback' : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
```

(`apps/server/src/index.ts`.) An unset value trusts `loopback`; a numeric
value is a hop count (Express treats the string `'1'` as an IP list, so
numbers are converted); anything else is passed through as-is.

This is required for two reasons:

1. **`req.ip` (rate-limiter key)**: Express reads the client IP from
   `X-Forwarded-For` only when it trusts the upstream.  Without this,
   `req.ip` is always `127.0.0.1` (the proxy address) and the login
   rate-limiter cannot distinguish between clients.

2. **`req.secure` / Secure cookie flag**: Express marks a request as
   secure (`req.protocol === 'https'`) only when the proxy sets
   `X-Forwarded-Proto: https` AND Express trusts that header.  The
   session cookie is issued with `Secure: true`; if `req.secure` is false
   the cookie will not be sent back by the browser.

The default value `loopback` trusts `127.0.0.1` / `::1`; correct when the
proxy and Node run on the same machine.  If the proxy runs on another host,
list it explicitly: `TRUST_PROXY=loopback,<proxy-ip>`.  Don't use a hop count
(`1`): Vite preview adds its own `X-Forwarded-For` hop, so `1` makes every
client look like the proxy and one attacker can lock everyone out of login.

---

## 7. Session revocation and authentication lifecycle

Tierwyn enforces server-side session controls and revocation:

- **Global session floor on logout:** Session cookies embed an issuance millisecond timestamp (`iatMs`) signed with HMAC-SHA256 (`SESSION_SECRET`). When the operator logs out via `POST /auth/logout` (enforcing same-origin checks), the server updates `auth.session_floor_ms` in the database. Any cookie issued before this floor is immediately rejected across all active browsers and devices.
- **Password change revocation:** Session cookies embed a password hash fingerprint (`ph`), derived from the HMAC of `OPERATOR_PASSWORD_HASH`. Rotating or updating the operator password hash instantly invalidates all existing session cookies across the entire deployment without manual database intervention.
- **Argon2 concurrency control:** In-flight password verification attempts are gated by an in-flight concurrency limiter (`tryAcquire` in `apps/server/src/auth/rateLimit.ts`), preventing argon2 resource-exhaustion race conditions.

---

## 8. Verify from a phone over HTTPS

1. Open `https://commandcentre.example.com` on a phone connected to the LAN.
2. Confirm **no TLS warning**; the certificate must be valid (not self-signed).
3. You should see the **login page** (not the shell), meaning auth is active.
4. Log in with the operator password. After login, open browser devtools
   (or use a proxy tool) and confirm:
   - The response `Set-Cookie` header includes `__Host-tierwyn_session=…; Secure; HttpOnly; SameSite=Lax`
     (plain `tierwyn_session` when `COOKIE_SECURE=false`).
   - The cookie is **sent on subsequent requests** to the API and on the
     WebSocket upgrade.
5. Reload the page; the shell should appear immediately (cookie valid, no
   login prompt), confirming the WS upgrade is also working through the proxy.
6. Use the logout button; you should be returned to the login screen and the
   cookie should be cleared.

---

## 9. LAN-exposure checklist

Before making the app reachable from any device other than localhost:

- [ ] `AUTH_DISABLED` is absent from `.env` or explicitly set to `false` (server enforces loopback-only bind if enabled).
- [ ] `OPERATOR_PASSWORD_HASH` is set to a real argon2 hash (not the example placeholder).
- [ ] `SESSION_SECRET` is set to a random value (not the example placeholder).
- [ ] `COOKIE_SECURE` is absent (defaults `true`) or explicitly `true`.
- [ ] `HOST` is `127.0.0.1`: Node must NOT bind to `0.0.0.0`.
- [ ] `TIERWYN_OUTBOUND_ALLOW` is configured if any internal LAN endpoints or private IPs must be reachable.
- [ ] The proxy terminates TLS with a valid certificate (no self-signed certs).
- [ ] `TRUST_PROXY` is set appropriately for your proxy topology (default `loopback` is correct for same-machine proxy).

---

## 10. Optional: LAN-subnet allowlist

Both proxy configs include a commented-out block that restricts access to a
single subnet (e.g. `192.168.1.0/24`).  This is a secondary security layer:
the password is the primary gate.  Enable it to prevent devices outside your
home network (e.g. if your router exposes port 443) from even reaching the
login page.

Uncomment and adjust the subnet in `Caddyfile.example` or `nginx.conf.example`
before deploying.
