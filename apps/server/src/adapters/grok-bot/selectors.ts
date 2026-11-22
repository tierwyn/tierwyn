/**
 * The only file that knows Grok Bot's DOM.
 * Live-verified v0.30.0: div.tiptap.ProseMirror.sand-prompt-field, no data-testid.
 * Approval cards have no stable class — inject.ts matches Allow once / Never / Always
 * allow by button text (feasibility §1) and stamps data-tierwyn-approval-id.
 * Deny still matches via inject regex; choice id stays `deny`.
 */
export const SELECTORS = {
  composer: [
    'div.tiptap.ProseMirror.sand-prompt-field[role="textbox"][aria-label="Prompt"]',
    'div.sand-prompt-field[role="textbox"]',
    '[aria-label="Prompt"][role="textbox"]',
  ],
  sendButton: [
    'button[aria-label="Send message"]',
    'button.sand-prompt-send[type="submit"]',
    'button[aria-label="Send"]',
    'button[type="submit"]',
  ],
  fileInput: [
    'input.sand-prompt-file-input',
    '.sand-kit-message-input-frame input[type=file]',
  ],
  approvalCard: [
    '[data-tierwyn-approval-id]',
    '[role="dialog"]',
  ],
} as const;

/** Documented chat message that ends the current Grok Bot turn. */
export const STOP_NOW = 'Stop now';

/** Fallback labels for Allow once / Never / Always allow.
 *  For Grok Bot, choice id `deny` is the desktop "Never" (legacy "Deny" still
 *  matches). Live scan prefers the button's own text over these fallbacks. */
export const APPROVAL_CHOICES = [
  { id: 'allow_once', label: 'Allow once' },
  { id: 'deny', label: 'Never' },
  { id: 'always_allow', label: 'Always allow' },
] as const;

export type ApprovalChoiceId = (typeof APPROVAL_CHOICES)[number]['id'];

/** Sidebar row for one Bot. Carries `data-agent-id` and, nested, the
 *  `data-grok-state` mark ("idle" | "working") that is the app's own busy
 *  signal — the only reliable way to tell a tool loop from a finished turn. */
export function agentItemSelector(agentId: string): string {
  return `.sand-agent-item[data-agent-id="${CSS_ESCAPE(agentId)}"]`;
}

export function agentStateSelector(agentId: string): string {
  return `${agentItemSelector(agentId)} [data-grok-state]`;
}

/** Global SVG mark source id (`<g id="sand-agent-mark-source-<agentId>">`) inside
 *  its enclosing `[data-grok-state]` span. In v0.78.1+, Grok Bot renders a hidden
 *  mark source for every Bot regardless of whether the sidebar is collapsed or
 *  the header avatar is static. */
export function agentMarkSourceId(agentId: string): string {
  return `sand-agent-mark-source-${CSS_ESCAPE(agentId)}`;
}

/** Bot ids are UUIDs from the app roster; reject anything else rather than
 *  interpolating operator-supplied text into a selector. */
function CSS_ESCAPE(id: string): string {
  if (!/^[0-9a-fA-F-]{1,64}$/.test(id)) throw new Error(`unsafe agent id: ${id}`);
  return id;
}

/** Same mark on the header of the open chat. Used when the sidebar row is not
 *  rendered (collapsed sidebar, active search filter) — the adapter selects the
 *  target chat before typing, so the header reflects the same Bot. */
export const CHAT_HEADER_STATE = '.sand-chat-header__avatar [data-grok-state]';

export const IDLE_STATE = 'idle';

/**
 * Live-verified v0.30.0: synthetic `contextmenu` MouseEvent on
 * `.sand-agent-item[data-agent-id]` opens a Base UI popup
 * (`[role="menu"][data-component="menu-popup"][aria-label="Bot actions"]`),
 * not an Electron native menu and not Radix (`data-radix-*` is absent).
 *
 * Items (trimmed `textContent`, `[role="menuitem"]` DIVs):
 *   Pin · Move to new section · Mark as Read/Unread · Edit Profile ·
 *   Duplicate · Share as template · Copy conversation ID · Hide from sidebar ·
 *   Delete
 *
 * Closed popups linger in the DOM with `data-closed` + `data-ending-style` +
 * `pointer-events: none` + opacity 0 — counting `[role="menuitem"]` is NOT an
 * open signal. Dismiss: CDP `Input.dispatchKeyEvent` Escape (vk 27).
 *
 * Delete confirm is a DOM `[role="alertdialog"]` (not a native dialog) with
 * Cancel / Delete and copy: 'This permanently deletes the Bot and its chat
 * history. This can't be undone.'
 */
export const MENU_POPUP = '[role="menu"][data-component="menu-popup"], [role="menu"]';
export const MENU_ITEM = '[role="menuitem"]';
export const ALERT_DIALOG = '[role="alertdialog"]';
export const DELETE_MENU_ITEM = 'Delete';
export const CANCEL_MENU_ITEM = 'Cancel';

/**
 * Live-verified v0.78.1: Create Bot dialog.
 * `button[aria-label="New Bot"]` in the sidebar header either opens
 * `.sand-create-bot-dialog` directly or (when shared/team bots menu is enabled)
 * opens a `[role="menu"]` containing `[role="menuitem"]` `"Create a Bot"`.
 * Inside `.sand-create-bot-dialog`, type into `input[aria-label="Bot name"]`
 * with the native value setter + `input` event (React-controlled), then click
 * the `"Create"` button (`button` with trimmed text `"Create"`).
 * Dismiss on failure via `"Cancel"` button, `button[aria-label="Close dialog"]`,
 * or Escape.
 */
export const NEW_BOT_BUTTON = 'button[aria-label="New Bot"]';
export const CREATE_BOT_MENU_ITEM = 'Create a Bot';
export const CREATE_BOT_DIALOG = '.sand-create-bot-dialog, [role="dialog"].sand-create-bot-dialog';
export const CREATE_BOT_NAME_INPUT = '.sand-create-bot-dialog input[aria-label="Bot name"], input[aria-label="Bot name"]';
export const CREATE_BOT_SUBMIT_LABEL = 'Create';
export const CREATE_BOT_CANCEL_LABEL = 'Cancel';
export const CLOSE_CREATE_BOT_DIALOG = '.sand-create-bot-dialog button[aria-label="Close dialog"], button[aria-label="Close dialog"]';

export type SelectorRole = keyof typeof SELECTORS;

export type ProbeResult = { [K in SelectorRole]: string | null };

export function probeSelectors(matches: (selector: string) => boolean): ProbeResult {
  const out = {} as ProbeResult;
  for (const role of Object.keys(SELECTORS) as SelectorRole[]) {
    out[role] = SELECTORS[role].find((sel) => matches(sel)) ?? null;
  }
  return out;
}
