import { buildPromptPack, type PromptCollectionEntry } from '@tierwyn/shared';

export function promptFilename(entry: PromptCollectionEntry): string {
  let s = entry.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'prompt';
  if (s.length > 48) s = s.slice(0, 48).replace(/-+$/g, '');
  return `${s}.json`;
}

export function downloadPromptPack(entries: PromptCollectionEntry[], filename: string): void {
  // ponytail: duplicated from Sidebar's pack export; extract if a third caller appears
  const pack = buildPromptPack(entries);
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
