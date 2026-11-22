/** Append a prompt-collection body to the current draft, blank line between. */
export function composeInsert(current: string, body: string): string {
  return current.trim() ? `${current.replace(/\s+$/, '')}\n\n${body}` : body;
}
