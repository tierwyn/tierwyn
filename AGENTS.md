# AGENTS.md

Portable agent guide. Full reference: `CLAUDE.md`.

## What Tierwyn is

**Tierwyn**, said "TEER-win": *Tiers of agents.*

Web UI + API server that drives multiple AI coding agents (15 CLIs: Claude Code, Pi, OpenCode, KiloCode, Antigravity, Cursor, Hermes, Codex, Grok Build, Kiro, Qwen Code, OpenClaw, Kimi Code, GitHub Copilot, DeepSeek; plus the Grok Bot desktop app) from a browser. Spawns the `claude` CLI directly via `@anthropic-ai/claude-agent-sdk`. Single-user, no Anthropic API key.

Monorepo: `apps/server` (Express + WS), `apps/web` (React + Vite), `packages/shared` (contract boundary, build first).

## Commands

```bash
npm install
npm run build --workspace=packages/shared   # required before first run / after shared changes
npm run dev                                  # both server (8787) + web (5173), concurrent
npm run dev:server / npm run dev:web         # one side only
npm run test --workspace=apps/server
npm run typecheck                            # tsc --noEmit across workspaces
npm run build                                # all workspaces
npm run deploy:prod:full                     # prod: build all + restart API + web
npm run deploy:prod                          # prod: web-only build + restart
npm run package:plugins                      # build plugin .tar.gz from plugin-src/ into plugin-archives/
tierwyn setup | doctor | restart | config     # installer / doctor / units (scripts/install.sh)
tierwyn hub restart                           # dedicated hub user API+web (not this checkout)
tierwyn node setup|enroll|run|start|stop|restart|logs|update|allow|disallow|status  # remote-host daemon (not the hub)
                         # dual path: hub package (~/tierwyn-node, BUILD_ID) or GitHub git checkout; see docs/architecture/remote-hosts.md
```

## Critical safety rules

**Never run destructive git on `main` while prod is live.** Prod runs from this same checkout. `git checkout .`, `git reset --hard`, `git clean -fd`, or branch switches that touch `apps/web/vite.config.ts` will clobber uncommitted prod-critical edits. The next `tierwyn-prod-web.service` restart then serves a broken SPA.

Defensive rule: **commit `vite.config.ts` before branching.**

Other off-limits actions:
- Never set `HOST=0.0.0.0` in dev `.env` without a reverse proxy in front.
- Never set `AUTH_DISABLED=true` in prod.
- Never commit `.env`, the prod env file (e.g. `/etc/tierwyn/prod.env`), credentials, or token files.
- Never run `rm -rf`, `git push --force` to main, or `git checkout --` without explicit ask.

When in doubt on a destructive action, ask first.

## Production deployment (same repo)

| | Dev | Prod |
|---|---|---|
| Env | repo `.env` | prod env file outside the repo, e.g. `/etc/tierwyn/prod.env` (600, owned by the user running the units) |
| PORT | 8787 | 8788 |
| `TIERWYN_DB` | `./data/tierwyn.db` | `./data/prod.db` |
| Frontend | Vite 5173 | Vite preview 4173 (`--host 0.0.0.0`) |
| Daemon | terminal | `tierwyn-prod.service` + `tierwyn-prod-web.service` (user systemd units) |
| Piper / Kokoro TTS | optional sidecars | `tierwyn-piper.service` / `tierwyn-kokoro.service` (**not** started by the app; see `docs/deploy/operator-sidecars.md`). Kokoro is a native venv (cpu / cuda / rocm PyTorch, detected and chosen in `tierwyn sidecars`). |

Reverse proxy: a TLS reverse proxy (e.g. Nginx, Caddy, Nginx Proxy Manager) forwarding your domain → the host's :4173, with WebSocket upgrade enabled.

Routine deploy / restart: **`npm run deploy:prod:full`** (builds all workspaces, restarts `tierwyn-prod` + `tierwyn-prod-web`). Web-only: `npm run deploy:prod`.

Gotchas (full list in `CLAUDE.md`):
- `allowedHosts` in `apps/web/vite.config.ts`: Vite preview blocks unknown Host headers; set `TIERWYN_ALLOWED_HOSTS` (`true`/`all` or a hostname list) on the prod-web unit.
- `--host 0.0.0.0` on the preview unit: Vite default is loopback.
- The prod env file (e.g. `/etc/tierwyn/prod.env`) must be owned by the user running the units (a user systemd unit can't read root:root 600 files).
- `COOKIE_SECURE=false` for direct-HTTP testing; `true` behind TLS.
- `TRUST_PROXY` defaults to `loopback`; set `TRUST_PROXY=1` if your reverse proxy is on another host so Express trusts `X-Forwarded-*` headers.

## Architecture pointers

- Adapters live in `apps/server/src/adapters/<agent-name>/`, implement `AgentAdapter`.
- All agent output normalised to `NormalisedEvent` (`packages/shared/src/events.ts`).
- WebSocket protocol: `ClientFrame` / `ServerFrame` (`packages/shared/src/protocol.ts`).
- DB: SQLite via `better-sqlite3`, migrations in `apps/server/src/db/migrations/` (hand-registered in `index.ts`, not auto-discovered). Registered: `001_baseline.sql` (v1, the whole schema; every pre-release migration squashed into it at release). Next new migration is **2**.

- Scheduled jobs (tick prompt = template + current step + pipeline stages + optional pending context; one-shots auto-enabled, intervals opt-in, complete-job auto-archives): `apps/server/src/schedules/`, operator guide `docs/architecture/scheduled-jobs.md`.
- Conversation descriptions (first-prompt one-liner; spawn title is role-only): `docs/architecture/conversation-descriptions.md`.
- Browser / PWA notifications (opt-in, HTTPS): `docs/architecture/browser-notifications.md`.
- Whisper dictation Fast / Slow (cleanup-only vs one-shot context enhance): `docs/architecture/dictation.md`.
- Plugins (phase 2, vault + env fallback + child-env scrub; nothing bundled; source in `plugin-src/`, import tar.gz): `docs/architecture/plugins.md`.
- Project memories (DB-backed, FTS5 keyword recall ahead of prompts, project isolation, operator modal; replaces v0 memory.md): `docs/architecture/project-memory.md`.
- Operator rules (project + ancestor-chain conversation instructions, cookie-only, 4 KiB cap): `docs/architecture/operator-rules.md`.
- Remote Hosts (`tierwyn node`): hub `apps/server/src/node/nodeHub.ts` + node `main.ts`; dual install (hub package default vs GitHub git); operator guide `docs/architecture/remote-hosts.md`.
- Agent sandbox (bwrap): optional per-CLI-process isolation, 6-tier precedence (conversation → project → matrix defaults → global), monotonic spawn pin (parent-on → child `'on'`; off → `NULL`), operator-only control plane; guide `docs/architecture/sandbox.md`.

## Commit convention

Format: `type(scope): subject`

- **Types:** `feat | fix | docs | refactor | perf | test | chore | build | ci | style | revert`
- **Scopes:** `server | web | shared | adapters | spawn | schedules | tts | ui | deploy | security`
- **Breaking:** `!` after the type (`feat(ws)!:`) or `BREAKING CHANGE` in the body → changelog Breaking Changes → implies a major bump.
- **Security:** `security` / `sec:` anywhere in the subject → changelog Security section.

The changelog is generated from these subjects by the maintainer's release script (not in the public repo). `feat(web):` and `feat(ui):` both land in **UI & Layout**. No commit-msg hook / commitlint.

## Where to write markdown

| Kind | Path | Versioned? |
|---|---|---|
| Spawn task + RESULT handoff | `.tierwyn/delegates/<role>-<slug>.md` (+ `-RESULT.md`) | No (gitignored) |
| Architecture & deploy docs | `docs/architecture/`, `docs/deploy/` | Yes (main repo) |
| Agent instructions | `AGENTS.md`, `CLAUDE.md` (repo root) | Yes (main repo) |

If `AGENTS.local.md` is present in the workspace root, read it for operator-specific local environment rules.

Full subsystem reference, REST routes, and adapter authoring guide: `CLAUDE.md`.
