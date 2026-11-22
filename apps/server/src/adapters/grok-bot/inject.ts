/**
 * Composer focus / type / Enter, plus Phase 2 approval-card observer.
 * Live-verified: Input.insertText + Input.dispatchKeyEvent Enter (vk 13).
 */
import type { CdpLike } from './cdp.js';
import type { ApprovalCard, QuestionCard } from './mapping.js';
import { readRosterRows, readSelection } from './bridge.js';
import {
  SELECTORS, CHAT_HEADER_STATE, agentItemSelector, agentStateSelector, agentMarkSourceId,
  MENU_POPUP, MENU_ITEM, ALERT_DIALOG, DELETE_MENU_ITEM,
  NEW_BOT_BUTTON, CREATE_BOT_MENU_ITEM, CREATE_BOT_DIALOG, CREATE_BOT_NAME_INPUT,
  CREATE_BOT_SUBMIT_LABEL, CREATE_BOT_CANCEL_LABEL, CLOSE_CREATE_BOT_DIALOG,
} from './selectors.js';

const ENTER = {
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
  code: 'Enter',
  key: 'Enter',
  unmodifiedText: '\r',
  text: '\r',
};

function composerFindJs(): string {
  const sels = JSON.stringify([...SELECTORS.composer]);
  return `(() => {
    const sels = ${sels};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return { selector: s, text: (el.innerText || el.textContent || '') };
    }
    return null;
  })()`;
}

export async function probeComposer(client: CdpLike): Promise<string | null> {
  const hit = await client.evaluate<{ selector: string } | null>(composerFindJs());
  return hit?.selector ?? null;
}

export async function focusComposer(client: CdpLike): Promise<boolean> {
  const sels = JSON.stringify([...SELECTORS.composer]);
  const ok = await client.evaluate<boolean>(`(() => {
    const sels = ${sels};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      el.focus();
      if (typeof el.click === 'function') el.click();
      return true;
    }
    return false;
  })()`);
  return Boolean(ok);
}

export async function insertComposerText(client: CdpLike, text: string): Promise<void> {
  await focusComposer(client);
  await client.send('Input.insertText', { text });
  const sels = JSON.stringify([...SELECTORS.composer]);
  const current = await client.evaluate<string>(`(() => {
    const sels = ${sels};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return (el.innerText || el.textContent || '');
    }
    return '';
  })()`);
  if (current.includes(text)) return;
  // Fallback: set the ProseMirror node and fire a native input event.
  await client.evaluate(`(() => {
    const sels = ${sels};
    const text = ${JSON.stringify(text)};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    }
    return false;
  })()`);
}

export async function dispatchEnter(client: CdpLike): Promise<void> {
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ENTER });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
}

/** The app's per-Bot activity mark: "idle" when the turn is over, "working" while
 *  Grok is running tools (which can be minutes of silence between messages).
 *  null when the row is not rendered — callers must degrade, not block. */
export async function readAgentState(client: CdpLike, agentId: string): Promise<string | null> {
  const sels = JSON.stringify([agentStateSelector(agentId), CHAT_HEADER_STATE]);
  const markId = JSON.stringify(agentMarkSourceId(agentId));
  const v = await client.evaluate<string | null>(`(() => {
    for (const s of ${sels}) {
      const el = document.querySelector(s);
      if (el && el.dataset && el.dataset.grokState) return el.dataset.grokState;
    }
    const src = document.getElementById(${markId});
    const host = src && typeof src.closest === 'function' ? src.closest('[data-grok-state]') : null;
    if (host && host.dataset && host.dataset.grokState) return host.dataset.grokState;
    return null;
  })()`);
  return typeof v === 'string' ? v : null;
}

/** Trigger Grok Bot's background transcript prefetch (`onPointerEnter` ->
 *  `M.transcript.load(agentId, { background: true })`) on a sidebar row without
 *  clicking or changing the active chat selection (zero UI flicker). */
export async function prefetchAgentReplica(client: CdpLike, agentId: string): Promise<boolean> {
  const sel = JSON.stringify(agentItemSelector(agentId));
  return Boolean(await client.evaluate<boolean>(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    return true;
  })()`).catch(() => false));
}

/** The composer always posts to the chat that is on screen, so a prompt aimed at a
 *  specific Bot has to select that Bot's row first. */
export async function selectAgent(client: CdpLike, agentId: string): Promise<boolean> {
  const sel = JSON.stringify(agentItemSelector(agentId));
  return Boolean(await client.evaluate<boolean>(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    if (el.dataset.active === 'true') return true;
    el.click();
    return true;
  })()`));
}

export async function clickSendButton(client: CdpLike): Promise<boolean> {
  const sels = JSON.stringify([...SELECTORS.sendButton]);
  return Boolean(await client.evaluate<boolean>(`(() => {
    const sels = ${sels};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      el.click();
      return true;
    }
    return false;
  })()`));
}

export async function composerSend(client: CdpLike, text: string): Promise<void> {
  if (text) await insertComposerText(client, text);
  await dispatchEnter(client);
}

/** App bundle `maxStagedAttachments` (`uF=6` in Grok Bot 0.68.1 renderer). Fail fast before touching the composer. */
export const MAX_STAGED_ATTACHMENTS = 6;

export interface AttachComposerFilesOpts {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Drive the composer's own file input (same path as "+"). Returns false if the
 * input is missing or staging does not finish in time.
 */
export type AttachComposerFilesResult = 'ok' | 'missing' | 'timeout';

export async function attachComposerFiles(
  client: CdpLike,
  paths: string[],
  names: string[],
  opts: AttachComposerFilesOpts = {},
): Promise<AttachComposerFilesResult> {
  if (paths.length === 0) return 'ok';
  let nodeId: number | undefined;
  try {
    const doc = await client.send<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: 0 });
    const rootId = doc?.root?.nodeId;
    if (typeof rootId !== 'number') return 'missing';
    for (const selector of SELECTORS.fileInput) {
      const hit = await client.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector });
      if (hit?.nodeId) { nodeId = hit.nodeId; break; }
    }
    if (!nodeId) return 'missing';
    await client.send('DOM.setFileInputFiles', { nodeId, files: paths });
  } catch {
    return 'missing';
  }
  const wait = opts.sleep ?? sleep;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const namesJson = JSON.stringify(names);
  const ready = await pollUntil(wait, timeoutMs, pollMs, async () => {
    const ok = await client.evaluate<boolean>(`(() => {
      const frame = document.querySelector('.sand-kit-message-input-frame');
      if (!frame) return false;
      if (frame.querySelector('[data-busy], .spinner, [aria-busy="true"]')) return false;
      const text = (frame.innerText || frame.textContent || '');
      const names = ${namesJson};
      return names.every((n) => text.includes(n));
    })()`).catch(() => false);
    return Boolean(ok);
  });
  return ready ? 'ok' : 'timeout';
}

/**
 * Idempotent page install: MutationObserver keeps window.__tierwynGrokBotApprovals
 * current, and window.__tierwynGrokBotClick(cardId, choiceId) clicks the button.
 * Returns the live card list. Text matching, not class names — the app has no
 * data-testid and approval chrome changes weekly (R2).
 */
export const APPROVAL_SCAN_JS = `(() => {
  /* __tierwynGrokBotScan */
  const CHOICES = [
    { id: 'allow_once', label: 'Allow once', re: /allow\\s*once/i },
    { id: 'always_allow', label: 'Always allow', re: /always\\s*allow/i },
    { id: 'deny', label: 'Never', re: /^(deny|never)$/i },
  ];
  const btnLabel = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const classify = (el) => {
    const t = btnLabel(el);
    for (const c of CHOICES) if (c.re.test(t)) return c;
    return null;
  };
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };
  const findCards = () => {
    const classified = [...document.querySelectorAll('button')].map((el) => ({ el, c: classify(el) })).filter((x) => x.c);
    const seen = new Set();
    const cards = [];
    for (const { el } of classified) {
      let node = el.parentElement;
      let cardEl = null;
      while (node && node !== document.body) {
        const ids = new Set([...node.querySelectorAll('button')].map(classify).filter(Boolean).map((k) => k.id));
        if (ids.has('allow_once') && ids.has('deny')) { cardEl = node; break; }
        node = node.parentElement;
      }
      if (!cardEl || seen.has(cardEl)) continue;
      if (cardEl.dataset.tierwynApprovalAnswered === 'true') continue;
      seen.add(cardEl);
      const contentKey = String(Math.abs(hash((cardEl.innerText || '').slice(0, 200))));
      if (!cardEl.dataset.tierwynApprovalId || cardEl.dataset.tierwynApprovalKey !== contentKey) {
        window.__tierwynGrokBotApprovalSeq = (window.__tierwynGrokBotApprovalSeq || 0) + 1;
        cardEl.dataset.tierwynApprovalKey = contentKey;
        cardEl.dataset.tierwynApprovalId = 'gb-' + contentKey + '-' + window.__tierwynGrokBotApprovalSeq;
      }
      const classifiedBtns = [...cardEl.querySelectorAll('button')].map((b) => ({ b, c: classify(b) })).filter((x) => x.c);
      const present = new Set(classifiedBtns.map((x) => x.c.id));
      // Prefer the live button text so Deny stays Deny and Never stays Never in Tierwyn.
      const choices = CHOICES.filter((c) => present.has(c.id)).map((c) => {
        const hit = classifiedBtns.find((x) => x.c.id === c.id);
        return { id: c.id, label: hit ? btnLabel(hit.b) : c.label };
      });
      let prompt = (cardEl.innerText || '').replace(/\\s+/g, ' ').trim();
      // Anchored CHOICES.re cannot strip mid-prompt; strip known button phrases by word.
      prompt = prompt.replace(/\\b(?:always\\s*allow|allow\\s*once|deny|never)\\b/gi, '').trim();
      prompt = prompt.replace(/\\s+/g, ' ').trim() || 'Grok Bot wants approval';
      cards.push({ cardId: cardEl.dataset.tierwynApprovalId, prompt, choices });
    }
    return cards;
  };
  window.__tierwynGrokBotClick = (cardId, choiceId) => {
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(cardId) : String(cardId).replace(/"/g, '');
    const card = document.querySelector('[data-tierwyn-approval-id="' + esc + '"]');
    if (!card) return false;
    const want = CHOICES.find((c) => c.id === choiceId);
    if (!want) return false;
    const btn = [...card.querySelectorAll('button')].find((b) => want.re.test(btnLabel(b)));
    if (!btn) return false;
    card.dataset.tierwynApprovalAnswered = 'true';
    btn.click();
    return true;
  };
  if (!window.__tierwynGrokBotInstalled) {
    window.__tierwynGrokBotInstalled = true;
    const mo = new MutationObserver(() => { window.__tierwynGrokBotApprovals = findCards(); });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
  window.__tierwynGrokBotApprovals = findCards();
  return window.__tierwynGrokBotApprovals;
})()`;

export async function scanApprovals(client: CdpLike): Promise<ApprovalCard[]> {
  const cards = await client.evaluate<ApprovalCard[] | null>(APPROVAL_SCAN_JS);
  return Array.isArray(cards) ? cards.filter((c) => c && typeof c.cardId === 'string') : [];
}

export async function clickApproval(client: CdpLike, cardId: string, choiceId: string): Promise<boolean> {
  await scanApprovals(client);
  return Boolean(await client.evaluate<boolean>(
    `window.__tierwynGrokBotClick(${JSON.stringify(cardId)}, ${JSON.stringify(choiceId)})`,
  ));
}

/**
 * Onboarding question cards: article / .sand-message-card
 * wrapping a <form>, lettered `button.sand-button` (`/^[A-E]\\s/`), optional
 * textarea[aria-label="Custom answer"], dismiss via aria-label "Dismiss question".
 */
export const QUESTION_SCAN_JS = `(() => {
  /* __tierwynGrokBotQuestionScan */
  const LETTER = /^([A-E])\\s/;
  const btnLabel = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };
  const findCards = () => {
    const seen = new Set();
    const cards = [];
    for (const form of document.querySelectorAll('form')) {
      const letterBtns = [...form.querySelectorAll('button')].filter((b) => LETTER.test(btnLabel(b)));
      const hasCustom = form.querySelector('textarea[aria-label="Custom answer"]');
      if (letterBtns.length === 0 && !hasCustom) continue;
      if (seen.has(form)) continue;
      if (form.dataset.tierwynQuestionAnswered === 'true') continue;
      seen.add(form);
      const choices = letterBtns.map((b) => {
        const t = btnLabel(b);
        const m = LETTER.exec(t);
        return { id: m[1], label: t };
      });
      if (form.querySelector('button[aria-label="Dismiss question"]')) {
        choices.push({ id: 'dismiss', label: 'Dismiss' });
      }
      let prompt = '';
      const clone = form.cloneNode(true);
      for (const el of clone.querySelectorAll('button, textarea, input')) el.remove();
      prompt = (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim()
        || 'Grok Bot has a question';
      const nextId = 'gbq-' + Math.abs(hash(prompt.slice(0, 200))).toString(36);
      if (form.dataset.tierwynQuestionId !== nextId) {
        form.dataset.tierwynQuestionId = nextId;
      }
      cards.push({
        cardId: form.dataset.tierwynQuestionId,
        prompt,
        choices,
        allowFreeText: true,
      });
    }
    return cards;
  };
  window.__tierwynGrokBotQuestionClick = (cardId, choiceId) => {
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(cardId) : String(cardId).replace(/"/g, '');
    const card = document.querySelector('[data-tierwyn-question-id="' + esc + '"]');
    if (!card) return false;
    card.dataset.tierwynQuestionAnswered = 'true';
    if (choiceId === 'dismiss') {
      const btn = card.querySelector('button[aria-label="Dismiss question"]');
      if (!btn) return false;
      btn.click();
      return true;
    }
    const btn = [...card.querySelectorAll('button')].find((b) => {
      const t = btnLabel(b);
      const m = LETTER.exec(t);
      return m && m[1] === choiceId;
    });
    if (!btn) return false;
    btn.click();
    return true;
  };
  window.__tierwynGrokBotQuestionFreeText = (cardId, text) => {
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(cardId) : String(cardId).replace(/"/g, '');
    const card = document.querySelector('[data-tierwyn-question-id="' + esc + '"]');
    if (!card) return false;
    card.dataset.tierwynQuestionAnswered = 'true';
    const ta = card.querySelector('textarea[aria-label="Custom answer"]');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  return findCards();
})()`;

export async function waitForSelectedChat(
  client: CdpLike,
  agentId: string,
  opts: DeleteAgentOpts = {},
): Promise<boolean> {
  const wait = opts.sleep ?? sleep;
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const pollMs = opts.pollMs ?? 50;
  const sel = JSON.stringify(agentItemSelector(agentId));
  const idJson = JSON.stringify(agentId);
  return pollUntil(wait, timeoutMs, pollMs, async () => {
    const ready = await client.evaluate<boolean>(`(() => {
      const el = document.querySelector(${sel});
      if (el && el.dataset.active === 'true') return true;
      const header = document.querySelector('.sand-chat-header [data-agent-id]');
      if (header && header.getAttribute('data-agent-id') === ${idJson}) return true;
      return false;
    })()`);
    if (ready) return true;
    return (await readSelection(client)) === agentId;
  });
}

export async function scanQuestionCards(client: CdpLike): Promise<QuestionCard[]> {
  const cards = await client.evaluate<QuestionCard[] | null>(QUESTION_SCAN_JS);
  return Array.isArray(cards) ? cards.filter((c) => c && typeof c.cardId === 'string') : [];
}

export async function clickQuestion(client: CdpLike, cardId: string, choiceId: string): Promise<boolean> {
  await scanQuestionCards(client);
  return Boolean(await client.evaluate<boolean>(
    `window.__tierwynGrokBotQuestionClick(${JSON.stringify(cardId)}, ${JSON.stringify(choiceId)})`,
  ));
}

export async function answerQuestionFreeText(
  client: CdpLike, cardId: string, text: string,
): Promise<boolean> {
  await scanQuestionCards(client);
  const ok = Boolean(await client.evaluate<boolean>(
    `window.__tierwynGrokBotQuestionFreeText(${JSON.stringify(cardId)}, ${JSON.stringify(text)})`,
  ));
  if (!ok) return false;
  await dispatchEnter(client);
  return true;
}

const ESCAPE = {
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: 'Escape',
  key: 'Escape',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Open the Bot-actions context menu. Throws on a non-UUID id (via agentItemSelector). */
export async function openAgentContextMenu(client: CdpLike, agentId: string): Promise<boolean> {
  const sel = JSON.stringify(agentItemSelector(agentId));
  return Boolean(await client.evaluate<boolean>(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, view: window, button: 2, buttons: 2,
      clientX: r.left + 24, clientY: r.top + 12,
    }));
    return true;
  })()`));
}

/** Click a visible (not data-closed) menuitem by trimmed textContent. */
export async function clickMenuItem(client: CdpLike, label: string): Promise<boolean> {
  return Boolean(await client.evaluate<boolean>(`(() => {
    const label = ${JSON.stringify(label)};
    const menus = [...document.querySelectorAll(${JSON.stringify(MENU_POPUP)})]
      .filter((m) => m.hasAttribute('data-open') && !m.hasAttribute('data-closed'));
    if (menus.length === 0) return false;
    const items = menus.flatMap((m) => [...m.querySelectorAll(${JSON.stringify(MENU_ITEM)})]);
    const item = items.find((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === label);
    if (!item) return false;
    item.click();
    return true;
  })()`));
}

/** CDP Escape — live-verified v0.30.0; the closed popup lingers with data-closed. */
export async function dismissMenu(client: CdpLike): Promise<void> {
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ESCAPE });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ESCAPE });
}

async function clickAlertButton(client: CdpLike, label: string): Promise<boolean> {
  return Boolean(await client.evaluate<boolean>(`(() => {
    const label = ${JSON.stringify(label)};
    const dlg = document.querySelector(${JSON.stringify(ALERT_DIALOG)});
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll('button')].find((b) =>
      (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim() === label);
    if (!btn) return false;
    btn.click();
    return true;
  })()`));
}

export interface DeleteAgentOpts {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

export type CreateAgentOpts = DeleteAgentOpts;

/**
 * Delete a Bot via the app's own context menu + alertdialog confirm.
 * Returns true once the id is gone from the roster. Every failure branch
 * dismisses the menu so a stuck popup is not left on the operator's app.
 */
export async function deleteAgent(
  client: CdpLike,
  agentId: string,
  opts: DeleteAgentOpts = {},
): Promise<boolean> {
  const wait = opts.sleep ?? sleep;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 200;
  const fail = async (): Promise<false> => {
    await dismissMenu(client).catch(() => undefined);
    return false;
  };
  agentItemSelector(agentId);
  try {
    await selectAgent(client, agentId);
    if (!(await openAgentContextMenu(client, agentId))) return fail();
    await wait(300);
    if (!(await clickMenuItem(client, DELETE_MENU_ITEM))) return fail();
    const confirmed = await pollUntil(wait, timeoutMs, pollMs, () => clickAlertButton(client, DELETE_MENU_ITEM));
    if (!confirmed) return fail();
    const gone = await pollUntil(wait, timeoutMs, pollMs, async () => {
      const rows = await readRosterRows(client);
      return !rows.some((r) => r.id === agentId);
    });
    if (!gone) return fail();
    return true;
  } catch (err) {
    await dismissMenu(client).catch(() => undefined);
    throw err;
  }
}

async function clickSelector(client: CdpLike, selector: string): Promise<boolean> {
  return Boolean(await client.evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`));
}

async function typeCreateName(client: CdpLike, name: string): Promise<boolean> {
  return Boolean(await client.evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(CREATE_BOT_NAME_INPUT)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(name)});
    else el.value = ${JSON.stringify(name)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`));
}

async function clickCreateBotSubmit(client: CdpLike): Promise<boolean> {
  return Boolean(await client.evaluate<boolean>(`(() => {
    const label = ${JSON.stringify(CREATE_BOT_SUBMIT_LABEL)};
    const scope = document.querySelector(${JSON.stringify(CREATE_BOT_DIALOG)}) || document;
    const btn = [...scope.querySelectorAll('button')].find((b) => {
      if (b.disabled) return false;
      const t = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim();
      return t === label;
    });
    if (!btn) return false;
    btn.click();
    return true;
  })()`));
}

async function dismissCreateBotDialog(client: CdpLike): Promise<void> {
  const closed = await client.evaluate<boolean>(`(() => {
    const closeBtn = document.querySelector(${JSON.stringify(CLOSE_CREATE_BOT_DIALOG)});
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    const dlg = document.querySelector(${JSON.stringify(CREATE_BOT_DIALOG)});
    if (!dlg) return false;
    const cancelBtn = [...dlg.querySelectorAll('button')].find((b) =>
      (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(CREATE_BOT_CANCEL_LABEL)},
    );
    if (!cancelBtn) return false;
    cancelBtn.click();
    return true;
  })()`);
  if (!closed) await dismissMenu(client).catch(() => undefined);
}

function pickNewBotId(
  before: Set<string>,
  rows: Array<{ id?: string; name?: string }>,
  name: string,
): string | null {
  const want = name.trim();
  const newcomers = rows.filter((r): r is { id: string; name?: string } =>
    typeof r.id === 'string' && r.id.length > 0 && !before.has(r.id),
  );
  const named = newcomers.find((r) => (r.name ?? '').trim() === want);
  return named?.id ?? newcomers[0]?.id ?? null;
}

/**
 * Create a named Bot via the app's Create Bot dialog (`button[aria-label="New Bot"]`).
 * Returns the new roster id, or null on any failure. Every failure branch closes
 * the dialog or menu (Close dialog / Cancel / Escape) so the operator's app is not
 * left with a modal open.
 */
export async function createAgent(
  client: CdpLike,
  name: string,
  opts: CreateAgentOpts = {},
): Promise<string | null> {
  const title = name.trim();
  if (!title) return null;
  const wait = opts.sleep ?? sleep;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 200;
  const fail = async (): Promise<null> => {
    await dismissCreateBotDialog(client).catch(() => undefined);
    return null;
  };
  try {
    const beforeRows = await readRosterRows(client);
    const before = new Set(beforeRows.map((r) => r.id));
    const opened = await clickSelector(client, NEW_BOT_BUTTON);
    if (!opened) {
      const alreadyOpen = await typeCreateName(client, title);
      if (!alreadyOpen) return fail();
    } else {
      const typed = await pollUntil(wait, timeoutMs, pollMs, async () => {
        if (await typeCreateName(client, title)) return true;
        await clickMenuItem(client, CREATE_BOT_MENU_ITEM).catch(() => false);
        return typeCreateName(client, title);
      });
      if (!typed) return fail();
    }
    const clicked = await pollUntil(wait, timeoutMs, pollMs, () => clickCreateBotSubmit(client));
    if (!clicked) return fail();
    let found: string | null = null;
    const appeared = await pollUntil(wait, timeoutMs, pollMs, async () => {
      const rows = await readRosterRows(client);
      found = pickNewBotId(before, rows, title);
      return found !== null;
    });
    if (!appeared || !found) return fail();
    return found;
  } catch (err) {
    await dismissCreateBotDialog(client).catch(() => undefined);
    throw err;
  }
}

async function pollUntil(
  wait: (ms: number) => Promise<void>,
  timeoutMs: number,
  pollMs: number,
  fn: () => Promise<boolean> | boolean,
  now: () => number = Date.now,
): Promise<boolean> {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await wait(pollMs);
  }
  return false;
}
