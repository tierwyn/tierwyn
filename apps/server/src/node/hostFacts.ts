import { hostname as osHostname } from 'os';
import type { Project, RemoteHostView } from '@tierwyn/shared';

export interface HostFacts {
  hostname: string;
  port: number;
  remote?: { hostId: string; os: string; artifactsRoot?: string };
}

export function hostFacts(
  project: Pick<Project, 'remoteHostId'>,
  localPort: number,
  view?: (id: string) => RemoteHostView | undefined,
): HostFacts {
  const id = project.remoteHostId;
  if (!id) return { hostname: osHostname(), port: localPort };
  const hello = view?.(id)?.hello ?? {};
  return {
    hostname: hello.hostname ?? '',
    port: hello.listenPort ?? localPort,
    remote: { hostId: id, os: hello.os ?? '', artifactsRoot: hello.artifactsRoot },
  };
}

export function remoteHostNote(f: HostFacts, cwd: string, conversationId?: string): string {
  const osName = f.remote?.os ?? '';
  const base = `You are running on host \`${f.hostname}\` (\`${osName}\`), working directory \`${cwd}\`. All of your tools execute on this machine. The Tierwyn server is reachable at \`http://127.0.0.1:${f.port}\` from here.`;
  if (f.remote?.artifactsRoot && conversationId) {
    return `${base} Tierwyn artifacts for this conversation live in \`${f.remote.artifactsRoot}/${conversationId}/\` on this host.`;
  }
  return base;
}
