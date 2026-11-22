import type { RemoteHostView } from '@tierwyn/shared';
import { remoteHostAddedAs, remoteHostSidebarTooltip } from '../remoteHostSidebar.js';

export function RemoteHostHeaderMeta({ host }: { host: RemoteHostView | undefined }) {
  if (!host) return null;
  const addedAs = remoteHostAddedAs(host);
  const desc = host.description?.trim();
  if (!addedAs && !desc) return null;
  return (
    <div className="host-header-meta" title={remoteHostSidebarTooltip(host)}>
      {addedAs ? <span className="host-header-meta-ip">{addedAs}</span> : null}
      {desc ? <span className="host-header-meta-desc">{desc}</span> : null}
    </div>
  );
}
