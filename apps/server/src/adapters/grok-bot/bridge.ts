/**
 * Typed accessors over window.desktop.main clientPersistence & attachment IPCs.
 * All reads. Unwraps {schemaVersion,value} envelopes verified in Phase 0/1 probes.
 */
import { createHash } from 'crypto';
import { mkdir, rename, writeFile, access } from 'fs/promises';
import { join, extname } from 'path';
import type { MessageFile, ModelDescriptor } from '@tierwyn/shared';
import type { CdpLike } from './cdp.js';
import { replicaEntries, replicaEnvelopeMalformed, unwrapSlice, type ReplicaEntry } from './mapping.js';

const PERSIST = 'window.desktop.main';

export interface RosterRow {
  id: string;
  name?: string;
  lastActivityAt?: number | string;
  lastEntry?: { kind?: string; text?: string };
  lastMessageId?: string;
  newestEntryId?: string;
  awaitingUserResponse?: unknown;
  unreadCount?: number;
}

/** Roster ids are UUIDs; the seeded `default` profile means "whatever chat is open". */
export const BOT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Map a roster snapshot to catalogue descriptors. Shared by listModels() and
 *  the watcher reconcile so picker labels and auto-created model rows cannot drift. */
export function rosterModelDescriptors(rows: unknown[]): ModelDescriptor[] {
  const list = Array.isArray(rows) ? rows : [];
  const out: ModelDescriptor[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { id?: unknown; name?: unknown };
    if (typeof r.id !== 'string' || !BOT_ID_RE.test(r.id)) continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    out.push({
      name: r.id,
      label: `Grok Bot · ${name || r.id}`,
      provider: 'xai',
      vision: true,
      steer: true,
    });
  }
  return out;
}

export async function listKeys(client: CdpLike, prefix = ''): Promise<string[]> {
  const raw = await client.evaluate<unknown>(`${PERSIST}.listClientPersistenceKeys({ prefix: ${JSON.stringify(prefix)} })`);
  const v = unwrapSlice(raw);
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

export async function readSlice<T>(client: CdpLike, key: string): Promise<T> {
  const raw = await client.evaluate<unknown>(`${PERSIST}.readClientPersistence({ key: ${JSON.stringify(key)} })`);
  return unwrapSlice<T>(raw);
}

export function accountPrefixFromKeys(keys: string[]): string | null {
  const hit = keys.find((k) => k.startsWith('sand.client.slice.account.'));
  if (!hit) return null;
  const m = hit.match(/^(sand\.client\.slice\.account\.[^.]+\.)/);
  return m?.[1] ?? null;
}

/** Memoised so a watcher tick / in-turn poll does not listKeys on every replica read. */
let accountPrefixCache: string | null | undefined;

export function resetBridgeCache(): void {
  accountPrefixCache = undefined;
}

export async function listAccountSlicePrefix(client: CdpLike): Promise<string | null> {
  return accountPrefixFromKeys(await listKeys(client, ''));
}

async function resolveAccountPrefix(client: CdpLike, force = false): Promise<string | null> {
  if (!force && accountPrefixCache !== undefined) return accountPrefixCache;
  accountPrefixCache = await listAccountSlicePrefix(client);
  return accountPrefixCache;
}

async function readSliceBySuffix<T>(client: CdpLike, suffix: string): Promise<T | undefined> {
  const prefix = await resolveAccountPrefix(client);
  if (prefix) {
    const direct = await readSlice<T>(client, `${prefix}${suffix}`);
    if (direct !== undefined && direct !== null) return direct;
  }
  const retryPrefix = await resolveAccountPrefix(client, true);
  if (retryPrefix && retryPrefix !== prefix) {
    const again = await readSlice<T>(client, `${retryPrefix}${suffix}`);
    if (again !== undefined && again !== null) return again;
  }
  const keys = await listKeys(client, '');
  const key = keys.find((k) => k.endsWith(suffix) || k.includes(suffix));
  if (!key) return undefined;
  const resolved = accountPrefixFromKeys(keys);
  if (resolved) accountPrefixCache = resolved;
  return readSlice<T>(client, key);
}

export async function readSelection(client: CdpLike): Promise<string | null> {
  const v = await readSliceBySuffix<{ agentId?: string } | string>(client, 'selection.last-agent');
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.agentId ?? null;
}

export async function readRoster(client: CdpLike): Promise<RosterRow[]> {
  const v = await readSliceBySuffix<{ rows?: RosterRow[] } | RosterRow[]>(client, 'roster.last-roster');
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return Array.isArray(v.rows) ? v.rows : [];
}

/** Same as readRoster; named for the watcher tick (one evaluate, newestEntryId on each row). */
export async function readRosterRows(client: CdpLike): Promise<RosterRow[]> {
  return readRoster(client);
}

export async function readTranscriptReplica(client: CdpLike, agentId: string): Promise<ReplicaEntry[]> {
  return (await readTranscriptReplicaChecked(client, agentId)).entries;
}

export async function readTranscriptReplicaChecked(
  client: CdpLike,
  agentId: string,
): Promise<{ entries: ReplicaEntry[]; malformed: boolean }> {
  const raw = await readSliceBySuffix<unknown>(client, `transcript.replicas.${agentId}`);
  if (raw === undefined || raw === null) return { entries: [], malformed: false };
  if (replicaEnvelopeMalformed(raw)) return { entries: [], malformed: true };
  return { entries: replicaEntries(raw), malformed: false };
}

/** ponytail: inline data URLs, no attachment store. The bytes live in the Grok Bot
 *  sandbox (`file:///home/box/…`, unreachable from this host and un-fetchable from the
 *  renderer), so the app's own IPC is the only way out. Cap keeps a 3000px screenshot
 *  from bloating the events table; raise it or spill to disk if that ceiling bites. */
const MAX_INLINE_IMAGE_BYTES = 4_000_000;

export async function resolveAttachmentDataUrl(
  client: CdpLike,
  url: string,
): Promise<string | null> {
  const media = await client.evaluate<{ kind?: string; dataUrl?: string } | null>(
    `(async () => { try { return await window.desktop.main.resolveAttachmentMedia({ source: ${JSON.stringify(url)} }); }
      catch { return null; } })()`,
  ).catch(() => null);
  const dataUrl = media?.dataUrl;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  return dataUrl.length > MAX_INLINE_IMAGE_BYTES ? null : dataUrl;
}

export async function getAvailableModels(client: CdpLike): Promise<unknown> {
  return client.evaluate('window.desktop.agent.getAvailableModels()');
}

export function parseActivityAt(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Swap sandbox `file://` handles for data URLs the browser can render.
 *  An unresolvable image degrades to `](#unavailable)` and never throws. */
export async function inlineImages<T extends { type: string; payload: unknown }>(
  client: CdpLike,
  ev: T,
): Promise<T> {
  if (ev.type !== 'message') return ev;
  const p = ev.payload as { chunk?: string };
  const chunk = p?.chunk;
  if (typeof chunk !== 'string' || !chunk.includes('](file://')) return ev;
  const urls = [...new Set([...chunk.matchAll(/\]\((file:\/\/[^)]+)\)/g)].map((m) => m[1]))];
  let out = chunk;
  for (const url of urls) {
    const dataUrl = await resolveAttachmentDataUrl(client, url).catch(() => null);
    out = dataUrl
      ? out.split(`](${url})`).join(`](${dataUrl})`)
      : out.split(`](${url})`).join('](#unavailable)');
  }
  return { ...ev, payload: { ...(p as object), chunk: out } };
}

/** ponytail: matches express.json + /proxy caps; raise with ws maxPayload headroom (base64 ≈ 1.34×, operator WS 32 MiB) */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MEDIA_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  zip: 'application/zip',
};

function sanitiseExt(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
}

function mediaTypeFromName(name: string): string {
  return MEDIA_BY_EXT[sanitiseExt(name)] ?? 'application/octet-stream';
}

type TransientFile = MessageFile & { sandboxUrl?: string };

function stripSandbox(f: TransientFile): MessageFile {
  const { sandboxUrl: _, ...rest } = f;
  return rest;
}

/**
 * Pull sandbox file bytes via CDP. FileReader/Blob often fails on the shapes
 * contextBridge hands back (ArrayBuffer views, Buffer-like `{type,data}`, …);
 * encode to base64 in-page with an explicit Uint8Array coerce instead.
 * Optional `agentId` is the Bot UUID — some app builds require it as the 3rd arg.
 */
async function readSandboxBytes(
  client: CdpLike,
  url: string,
  agentId?: string,
): Promise<{ kind: string | null; size?: number; b64?: string; error?: string }> {
  const agentLit = agentId && BOT_ID_RE.test(agentId) ? JSON.stringify(agentId) : 'undefined';
  const expr = `(async () => {
    const toU8 = (bytes) => {
      if (bytes instanceof Uint8Array) return bytes;
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (Array.isArray(bytes)) return Uint8Array.from(bytes);
      if (bytes && bytes.type === 'Buffer' && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data);
      if (typeof bytes === 'string') {
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i) & 0xff;
        return out;
      }
      throw new Error('unsupported bytes type: ' + (bytes && bytes.constructor && bytes.constructor.name));
    };
    const toB64 = (u8) => {
      const CHUNK = 0x8000;
      let s = '';
      for (let i = 0; i < u8.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      return btoa(s);
    };
    try {
      const main = window.desktop.main;
      const agentId = ${agentLit};
      let r = await main.readAttachmentBytes(
        agentId !== undefined
          ? { path: ${JSON.stringify(url)}, maxBytes: ${MAX_ATTACHMENT_BYTES}, agentId }
          : { path: ${JSON.stringify(url)}, maxBytes: ${MAX_ATTACHMENT_BYTES} },
      );
      if (r == null && agentId !== undefined) {
        r = await main.readAttachmentBytes({ path: ${JSON.stringify(url)}, maxBytes: ${MAX_ATTACHMENT_BYTES} });
      }
      if (r && r.kind === 'bytes') {
        const u8 = toU8(r.bytes);
        return { kind: 'bytes', size: typeof r.size === 'number' ? r.size : u8.length, b64: toB64(u8) };
      }
      return { kind: r?.kind ?? null, size: r?.size };
    } catch (e) {
      return { kind: null, error: e && e.message ? String(e.message) : String(e) };
    }
  })()`;
  const got = await client.evaluate<{
    kind?: string | null; size?: number; b64?: string; error?: string;
  } | null>(expr);
  return {
    kind: got?.kind ?? null,
    size: got?.size,
    b64: got?.b64,
    ...(typeof got?.error === 'string' ? { error: got.error } : {}),
  };
}

async function persistBytes(
  buf: Buffer,
  name: string,
  attachmentsDir: string,
  conversationId: string,
): Promise<{ path: string; ext: string }> {
  const ext = sanitiseExt(name);
  const sha = createHash('sha256').update(buf).digest('hex');
  const dir = join(attachmentsDir, conversationId);
  const path = join(dir, `${sha}.${ext}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await access(path);
    return { path, ext };
  } catch {
    /* missing — write */
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, buf, { mode: 0o600 });
  await rename(tmp, path);
  return { path, ext };
}

const RESOLVE_ATTEMPTS = 3;
const RESOLVE_RETRY_MS = 250;

async function resolveOneFile(
  client: CdpLike,
  raw: TransientFile,
  opts: { conversationId: string; attachmentsDir: string; persist: boolean; agentId?: string },
): Promise<MessageFile> {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'file';
  const sandboxUrl = raw.sandboxUrl;
  const base: TransientFile = {
    name,
    mediaType: raw.mediaType || 'application/octet-stream',
    status: raw.status ?? 'unavailable',
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
  };
  if (typeof sandboxUrl !== 'string' || !sandboxUrl) return stripSandbox(base);
  if (!opts.persist) {
    console.warn('[grok-bot] attachment persist skipped (bad conversationId or attachmentsDir):', name);
    return stripSandbox({ ...base, status: 'unavailable' });
  }

  let lastKind: string | null = null;
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
    try {
      const r = await readSandboxBytes(client, sandboxUrl, opts.agentId);
      lastKind = r.kind;
      lastErr = r.error;
      if (r.kind === 'bytes' && typeof r.b64 === 'string') {
        const buf = Buffer.from(r.b64, 'base64');
        const { path } = await persistBytes(buf, name, opts.attachmentsDir, opts.conversationId);
        return stripSandbox({
          name,
          mediaType: mediaTypeFromName(name),
          status: 'ok',
          size: typeof r.size === 'number' ? r.size : buf.length,
          path,
        });
      }
      if (r.kind === 'too-large') {
        return stripSandbox({
          name,
          mediaType: mediaTypeFromName(name),
          status: 'too_large',
          ...(typeof r.size === 'number' ? { size: r.size } : {}),
        });
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RESOLVE_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RESOLVE_RETRY_MS));
    }
  }
  console.warn(
    '[grok-bot] attachment unavailable after retries:',
    name,
    'kind=', lastKind,
    lastErr ? `error=${lastErr}` : '',
  );
  return stripSandbox({ ...base, status: 'unavailable' });
}

export interface ResolveSandboxMediaOpts {
  conversationId: string;
  attachmentsDir: string;
  /** Bot UUID — forwarded to readAttachmentBytes when the app requires it. */
  agentId?: string;
}

/** inlineImages, then persist Bot-sent files under attachmentsDir and strip sandbox URLs. */
export async function resolveSandboxMedia<T extends { type: string; payload: unknown }>(
  client: CdpLike,
  ev: T,
  opts: ResolveSandboxMediaOpts,
): Promise<T> {
  ev = await inlineImages(client, ev);
  if (ev.type !== 'message') return ev;
  const p = ev.payload as { files?: TransientFile[] };
  if (!Array.isArray(p?.files) || p.files.length === 0) return ev;
  const persist = BOT_ID_RE.test(opts.conversationId) && typeof opts.attachmentsDir === 'string' && opts.attachmentsDir.length > 0;
  const files = await Promise.all(p.files.map((f) => resolveOneFile(client, f, { ...opts, persist })));
  return { ...ev, payload: { ...(p as object), files } };
}
