import type { Conversation } from '@tierwyn/shared';

/** Patch one conversation in a list, preserving client-only `isActive`.
 *  Returns the same array reference when nothing changed. */
export function patchConversationInList(
  list: Conversation[] | undefined,
  patch: Partial<Conversation> & { id: string },
): Conversation[] | undefined {
  if (!list) return list;
  let changed = false;
  const next = list.map((c) => {
    if (c.id !== patch.id) return c;
    changed = true;
    return { ...c, ...patch, isActive: c.isActive };
  });
  return changed ? next : list;
}
