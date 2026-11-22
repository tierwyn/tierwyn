import type { RemoteHostView } from '@tierwyn/shared';

type HostLike = Pick<RemoteHostView, 'name' | 'description'> & {
  hello?: Partial<RemoteHostView['hello']>;
};

/** Self-reported OS hostname from the node hello (e.g. `tierwyn-node-deb12`). */
export function remoteHostDetectedName(host: HostLike): string | undefined {
  const h = host.hello?.hostname?.trim();
  return h || undefined;
}

/** Primary sidebar / group label: detected hostname when known, else Settings name. */
export function remoteHostSidebarLabel(host: HostLike): string {
  return remoteHostDetectedName(host) ?? host.name;
}

/** The IP / name the operator typed when adding the host — shown only when it differs from the label. */
export function remoteHostAddedAs(host: HostLike): string | undefined {
  const name = host.name?.trim();
  return name && name !== remoteHostSidebarLabel(host) ? name : undefined;
}

/** Native `title` tooltip for host headers and chips. */
export function remoteHostSidebarTooltip(host: HostLike): string {
  return [
    `Added as: ${host.name?.trim() || '—'}`,
    `Description: ${host.description?.trim() || '—'}`,
  ].join('\n');
}

export function remoteHostMatchesSearch(host: HostLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [host.name, remoteHostDetectedName(host), host.description]
    .some((p) => (p ?? '').toLowerCase().includes(q));
}
