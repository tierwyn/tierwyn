import type { RemoteHostView } from '@tierwyn/shared';

export function installSourceLabel(hello: RemoteHostView['hello']): { source: 'git' | 'package'; id: string } {
  const source = hello.installSource ?? 'git';
  const sha = hello.gitSha ?? '';
  const short = !sha ? '—' : source === 'package' ? sha : sha.slice(0, 7);
  const id = hello.version ? `${hello.version} · ${short}` : short;
  return { source, id };
}
