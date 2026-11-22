import type { RemoteHostView } from '@tierwyn/shared';
import { remoteHostSidebarLabel } from './remoteHostSidebar.js';

export function remoteHostLabel(
  remoteHostId: string | null | undefined,
  hosts: Array<Pick<RemoteHostView, 'id' | 'name'> & { hello?: Partial<RemoteHostView['hello']> }>,
): string | undefined {
  if (!remoteHostId) return undefined;
  const host = hosts.find((h) => h.id === remoteHostId);
  return host ? remoteHostSidebarLabel(host) : 'remote host';
}
