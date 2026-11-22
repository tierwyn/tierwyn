import { config } from 'dotenv';
import { findEnvFile } from './env.js';
import { ensureAgentPath } from './node/policy.js';

// Side effect on import: load the nearest .env, searching upward from the CWD.
// Imported first by index.ts (before any module reads process.env) so it
// replaces the CWD-only behaviour of `dotenv/config`.
if (process.env.NODE_ENV !== 'production') {
  const envPath = findEnvFile(process.cwd());
  config(envPath ? { path: envPath } : {});
}

// Hub parity with `tierwyn node`: vendor installers (curl … | bash, npm prefix
// ~/.npm-global) land in well-known per-user dirs that systemd user units omit.
// Appended (not prepended) so an explicit operator PATH keeps precedence.
ensureAgentPath(process.env, undefined, true);
