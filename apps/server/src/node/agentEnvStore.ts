import type { AgentEnvSlice } from '../childEnv.js';
import { isValidAgentEnvName } from '../childEnv.js';

// Matches the vault's write minimum (plugins/host.ts `MIN_SECRET_LEN`); that
// module cannot be imported here — node-side code must stay DB-free.
const MIN_REDACT_LEN = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameValues(a: Record<string, Record<string, string>>, b: Record<string, Record<string, string>>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const agent of aKeys) {
    const av = a[agent]!;
    const bv = b[agent];
    if (!bv) return false;
    const aNames = Object.keys(av);
    const bNames = Object.keys(bv);
    if (aNames.length !== bNames.length) return false;
    for (const name of aNames) {
      if (av[name] !== bv[name]) return false;
    }
  }
  return true;
}

/**
 * Node-side, memory-only holder of hub-pushed per-agent vault env values.
 *
 * Values arrive over the WSS link via `agentEnv.sync` and are injected into
 * child environments through the `setAgentEnvSource` seam in `childEnv.ts`,
 * so adapters stay unchanged. They are never written to disk, never put on
 * argv, never logged, and never returned from any RPC response.
 *
 * `replace` treats its arguments as untrusted hub payloads: malformed names,
 * reserved names (PATH, LD_*, TIERWYN_*, …), non-string values and unknown
 * agents are dropped. Grok Bot is never allowed.
 */
export class AgentEnvStore {
  /** agentType → name → value, null-proto so `__proto__` is a plain key. */
  private vars: Record<string, Record<string, string>> = Object.create(null);
  private managedNames = new Set<string>();
  /** Every value ever held; retired ones keep redacting for the life of the process. */
  private readonly everHeld = new Set<string>();
  /** Bumped by `replace` on every real state change (see `revision`). */
  private generation = 0;

  constructor(private readonly allowedAgents: () => readonly string[]) {}

  /** Incremented each time `replace` swaps in a changed snapshot. Hello
   *  builders capture it before probing agents and discard the result if it
   *  moved: a background compute straddling an agentEnv.sync must not clobber
   *  the fresher, env-aware hello that sync's refresh produced. */
  get revision(): number {
    return this.generation;
  }

  replace(vars: unknown, managedNames?: unknown): { changed: boolean } {
    const v = isPlainObject(vars) ? vars : {};
    const extra = Array.isArray(managedNames) ? managedNames : [];

    const nextVars: Record<string, Record<string, string>> = Object.create(null);
    const nextManaged = new Set<string>();
    for (const [agentType, entries] of Object.entries(v)) {
      if (!isPlainObject(entries)) continue;
      for (const [name, value] of Object.entries(entries)) {
        if (!isValidAgentEnvName(name)) continue;
        if (typeof value !== 'string' || value === '') continue;
        nextManaged.add(name);
        if (!this.isAllowedAgent(agentType)) continue;
        let bucket = nextVars[agentType];
        if (!bucket) {
          bucket = Object.create(null);
          nextVars[agentType] = bucket;
        }
        bucket[name] = value;
        this.everHeld.add(value);
      }
    }
    for (const n of extra) {
      if (typeof n === 'string' && isValidAgentEnvName(n)) nextManaged.add(n);
    }

    const changed = !sameValues(this.vars, nextVars)
      || this.managedNames.size !== nextManaged.size
      || [...nextManaged].some((n) => !this.managedNames.has(n));
    this.vars = nextVars;
    this.managedNames = nextManaged;
    if (changed) this.generation++;
    return { changed };
  }

  /** `childEnv.setAgentEnvSource` seam. Bound so it can be passed as a bare reference. */
  slice = (agentType: string): AgentEnvSlice => {
    const own: Record<string, string> = Object.create(null);
    const bucket = agentType ? this.vars[agentType] : undefined;
    if (bucket) {
      for (const [name, value] of Object.entries(bucket)) {
        if (!isValidAgentEnvName(name)) continue;
        own[name] = value;
      }
    }
    return { own, managedNames: new Set(this.managedNames) };
  };

  /** Values for outgoing-frame redaction, longest first so a retired prefix
   *  of a newer value cannot leave a suffix behind. */
  secrets(): string[] {
    return [...this.everHeld]
      .filter((v) => v.length >= MIN_REDACT_LEN)
      .sort((a, b) => b.length - a.length);
  }

  private isAllowedAgent(agentType: string): boolean {
    return agentType !== 'grok-bot' && this.allowedAgents().includes(agentType);
  }
}
