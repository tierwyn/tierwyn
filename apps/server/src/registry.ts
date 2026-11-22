import type { AgentAdapter, SandboxPath } from '@tierwyn/shared';

export type AdapterFactoryOpts = {
  interactionMode?: 'bypass' | 'questions' | 'prompt';
  remoteHostId?: string | null;
  sandbox?: boolean;
  /** Extra bwrap binds; remote nodes re-validate against node.json. */
  sandboxPaths?: SandboxPath[];
  /** Node-injected policy roots re-checked at spawn. Hub must not set this. */
  sandboxRoots?: string[];
  /** Node-injected extra hard-deny paths. Hub must not set this. */
  sandboxDeny?: string[];
};

// ponytail: factory takes opts so /spawn can force bypass on children without
// touching global settings. Adapters that don't care ignore the field.
type AdapterFactory = (opts?: AdapterFactoryOpts) => AgentAdapter;
type RemoteFactory = (type: string, opts: AdapterFactoryOpts & { remoteHostId: string }) => AgentAdapter;

type RegistryEntry = { factory: AdapterFactory; label: string };

class AdapterRegistry {
  private entries = new Map<string, RegistryEntry>();
  private remoteFactory?: RemoteFactory;

  // ponytail: label defaults to agentType so test stubs don't need to pass it.
  register(agentType: string, factory: AdapterFactory, label: string = agentType): void {
    this.entries.set(agentType, { factory, label });
  }

  setRemoteFactory(f: RemoteFactory | undefined): void {
    this.remoteFactory = f;
  }

  create(agentType: string, opts?: AdapterFactoryOpts): AgentAdapter {
    if (opts?.remoteHostId) {
      if (!this.remoteFactory) throw new Error('remote hosts not initialised');
      return this.remoteFactory(agentType, opts as AdapterFactoryOpts & { remoteHostId: string });
    }
    const entry = this.entries.get(agentType);
    if (!entry) {
      throw new Error(`No adapter registered for agentType: ${agentType}`);
    }
    return entry.factory(opts);
  }

  has(agentType: string): boolean {
    return this.entries.has(agentType);
  }

  /** Display label registered for an agent type, for "usage is for X" labeling. */
  labelFor(agentType: string): string | undefined {
    return this.entries.get(agentType)?.label;
  }

  registeredTypes(): Set<string> {
    return new Set(this.entries.keys());
  }

  // ponytail: derives the discovery map from the same registrations so the
  // two can't drift. Discovery doesn't run turns, so bare factory() is fine.
  toDiscoverableAgents(): Record<string, { label: string; create: () => AgentAdapter }> {
    return Object.fromEntries(
      [...this.entries.entries()].map(([id, { factory, label }]) => [
        id,
        { label, create: () => factory() },
      ]),
    );
  }
}

export const registry = new AdapterRegistry();
