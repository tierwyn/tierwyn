import type { Conversation, Project, FileBrowserEntry } from '@tierwyn/shared';
import { chooseDefaultTree } from './gitWorkingTree.js';

export interface FileBrowserRoot { key: string; label: string; conversationId?: string; projectId: string }

const convoRoot = (c: Conversation): FileBrowserRoot => ({
  key: `c:${c.id}`, label: `Conversation: ${c.title}`, conversationId: c.id, projectId: c.projectId,
});
const projectRoot = (p: Project): FileBrowserRoot => ({
  key: `p:${p.id}`, label: `Project: ${p.name}`, projectId: p.id,
});

/** Default root: selected conversation → selected project → first project → null. Uses chooseDefaultTree. */
export function defaultBrowserRoot(
  selectedConversation: Conversation | null,
  selectedProject: Project | null,
  projects: Project[],
): FileBrowserRoot | null {
  const tree = chooseDefaultTree({ via: 'topbar', selectedConversation, selectedProject });
  if (tree?.conversationId && selectedConversation?.id === tree.conversationId) {
    return convoRoot(selectedConversation);
  }
  if (tree) {
    const p = projects.find((x) => x.id === tree.projectId)
      ?? (selectedProject?.id === tree.projectId ? selectedProject : undefined);
    return p ? projectRoot(p) : { key: `p:${tree.projectId}`, projectId: tree.projectId, label: selectedProject?.name ?? 'Project' };
  }
  return projects[0] ? projectRoot(projects[0]) : null;
}

/** Switcher options: selected conversation (if any) first, then every project. key = `c:<id>` / `p:<id>`. */
export function rootOptions(selectedConversation: Conversation | null, projects: Project[]): FileBrowserRoot[] {
  return [...(selectedConversation ? [convoRoot(selectedConversation)] : []), ...projects.map(projectRoot)];
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentRel(dir: string): string {
  const i = dir.lastIndexOf('/');
  return i < 0 ? '' : dir.slice(0, i);
}

export function breadcrumbs(dir: string, rootLabel: string): Array<{ label: string; path: string }> {
  const out = [{ label: rootLabel, path: '' }];
  if (!dir) return out;
  const parts = dir.split('/');
  parts.forEach((label, i) => out.push({ label, path: parts.slice(0, i + 1).join('/') }));
  return out;
}

/** Case-insensitive substring match on name; blank query → all. */
export function filterEntries(entries: FileBrowserEntry[], q: string): FileBrowserEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}
