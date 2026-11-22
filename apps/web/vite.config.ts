import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ponytail: single source of truth for proxy routes; shared by dev + preview.
const PROXY_TARGET = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:8787';

/**
 * Vite Host-header allowlist (DNS-rebinding protection).
 * Unset/empty → omit allowedHosts (Vite default: localhost + IPs only).
 * `true` or `all` → allow any Host (needed behind a reverse proxy until you list the domain).
 * Otherwise a comma-separated hostname list (trimmed).
 * Prod web unit sets TIERWYN_ALLOWED_HOSTS=true;
 * that disables Host checks (DNS-rebinding risk) — narrow it to your public hostname when you can.
 */
function allowedHostsFromEnv(): true | string[] | undefined {
  const raw = process.env.TIERWYN_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === 'all') {
    console.warn('[vite] TIERWYN_ALLOWED_HOSTS=true disables Host checks (DNS-rebinding risk). Set it to your public hostname(s).');
    return true;
  }
  const hosts = raw.split(',').map((h) => h.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

const allowedHosts = allowedHostsFromEnv();
const hostHeader = allowedHosts !== undefined ? { allowedHosts } : {};
// SECURITY: do not add '/agent' or broad '/agent/plugins' — /agent/schedule-help,
// /agent/plugins/help, and /agent/plugins/:id/help are loopback-only; proxying them would
// expose them to remote browsers (proxied traffic arrives from loopback and passes a naive
// socket check). Only capability execution paths are proxied below via regex.
const HTTP_ROUTES = [
  '/auth', '/profiles', '/projects', '/conversations', '/events',
  '/settings', '/agents', '/catalogue', '/models', '/files', '/spawn', '/proxy',
  '/transcribe',
  '/tts',
  '/enhance',
  '/schedule-packs',
  '/schedules',
  '/notifications',
  '/health', '/sessions', '/plugins', '/system', '/grok-bot', '/timers',
  '/tasks', '/mcp', '/rule-presets', '/remote-hosts', '/node',
  '/project-browse',
  '/sandbox',
  '/mesh',
  '/memories',
];
// xfwd: append the real peer to X-Forwarded-For so the API's login/enroll rate
// limiters key per client instead of collapsing every browser onto 127.0.0.1.
const target = { target: PROXY_TARGET, xfwd: true };
const proxy = {
  ...Object.fromEntries(HTTP_ROUTES.map((r) => [r, target])),
  '^/agent/plugins/[^/]+/capabilities/': target,
  '^/agent/mesh/': target,
  '/ws': { ...target, ws: true },
};
// frame-ancestors on the outer page blocks sibling-subdomain clickjacking;
// srcDoc iframes (HTML mock preview) are unaffected.
const FRAME_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; img-src 'self' data: blob:;",
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy,
    ...hostHeader,
    headers: {
      ...FRAME_HEADERS,
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    proxy,
    ...hostHeader,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      ...FRAME_HEADERS,
    },
  },
});
