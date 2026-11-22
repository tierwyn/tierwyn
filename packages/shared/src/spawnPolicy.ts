import type { Workdir } from './domain.js';

export type WorkdirSource =
  | 'manual-override'
  | 'conversation-pin'
  | 'request'
  | 'template-role'
  | 'global-default'
  | 'fallback';

export interface ResolvedWorkdir {
  workdir: Workdir;
  source: WorkdirSource;
  /** Set when a lower-precedence input asked for a DIFFERENT workdir. */
  suppressed?: { workdir: Workdir; source: WorkdirSource };
}

export interface SpawnWorkdirInput {
  manualChoice?: Workdir;          // SpawnModal explicit selection only
  conversationPin?: Workdir | null;
  requestWorkdir?: Workdir;        // bearer body / x-spawn-workdir header
  roleDefault?: Workdir;
  globalDefault?: Workdir;
}

export function resolveSpawnWorkdir(input: SpawnWorkdirInput): ResolvedWorkdir {
  const chain: Array<{ workdir: Workdir; source: WorkdirSource }> = [];
  if (input.manualChoice) chain.push({ workdir: input.manualChoice, source: 'manual-override' });
  if (input.conversationPin) chain.push({ workdir: input.conversationPin, source: 'conversation-pin' });
  if (input.requestWorkdir) chain.push({ workdir: input.requestWorkdir, source: 'request' });
  if (input.roleDefault) chain.push({ workdir: input.roleDefault, source: 'template-role' });
  if (input.globalDefault) chain.push({ workdir: input.globalDefault, source: 'global-default' });
  chain.push({ workdir: 'shared', source: 'fallback' }); // always last; winner is never undefined

  const winner = chain[0]!;
  const losers = chain.slice(1);

  // ponytail: suppression fires only at the pin boundary — the two design asymmetries:
  //   1. conversation-pin beats bearer request (agent can't escape an operator pin)
  //   2. manual-override beats conversation-pin (operator deliberately breaks the pin)
  // Normal precedence (role > global, request > role) is expected and stays silent.
  // The terminal 'fallback' is excluded — it is always present, never "asked" for anything.
  const suppressed = losers.find(
    (c) =>
      c.source !== 'fallback' &&
      c.workdir !== winner.workdir &&
      ((winner.source === 'conversation-pin' && c.source === 'request') ||
        (winner.source === 'manual-override' && c.source === 'conversation-pin')),
  );

  return {
    workdir: winner.workdir,
    source: winner.source,
    ...(suppressed ? { suppressed: { workdir: suppressed.workdir, source: suppressed.source } } : {}),
  };
}
