/** Builtin slash commands that legitimately complete with no assistant output. */
const SILENT_SUCCESS_COMMANDS: Record<string, string> = {
  compact: 'Context compacted successfully.',
  // Grok ACP toggles permission mode with no agent_message_chunk.
  'always-approve': 'Always-approve mode updated.',
};

/** Acknowledgement text when `text` is a silent-success slash command; null otherwise. */
export function silentSuccessAckFor(text: string): string | null {
  const match = text.trim().match(/^\/([\w-]+)(?:\s|$)/);
  if (!match) return null;
  return SILENT_SUCCESS_COMMANDS[match[1].toLowerCase()] ?? null;
}
