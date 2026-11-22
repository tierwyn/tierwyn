import { describe, it, expect } from 'vitest';
import type { CdpLike } from './cdp.js';
import {
  deleteAgent, dismissMenu, clickMenuItem, createAgent, scanQuestionCards, clickQuestion,
  answerQuestionFreeText, waitForSelectedChat, attachComposerFiles, readAgentState,
  prefetchAgentReplica, QUESTION_SCAN_JS, APPROVAL_SCAN_JS,
} from './inject.js';

const AGENT = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const PREFIX = 'sand.client.slice.account.acct.';
const KEYS = [
  `${PREFIX}selection.last-agent`,
  `${PREFIX}roster.last-roster`,
];

function makeClient(script: {
  hasDelete?: boolean;
  dialog?: boolean;
  gone?: boolean;
  rowPresent?: boolean;
}): { client: CdpLike; evaluates: string[]; sends: Array<{ method: string; params?: Record<string, unknown> }> } {
  const evaluates: string[] = [];
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let deleted = script.gone === true;
  const client: CdpLike = {
    async evaluate(expression: string) {
      evaluates.push(expression);
      if (expression.includes('unsafe')) return false;
      if (expression.includes('contextmenu')) return script.rowPresent !== false;
      if (expression.includes('alertdialog')) {
        if (script.dialog === false) return false;
        deleted = true;
        return true;
      }
      if (expression.includes('menuitem')) return script.hasDelete !== false;
      if (expression.includes('sand-agent-item')) return script.rowPresent !== false;
      if (expression.includes('listClientPersistenceKeys')) return KEYS;
      if (expression.includes('roster.last-roster')) {
        const ids = deleted && script.gone !== false ? [] : [AGENT];
        if (script.gone === false) {
          return { schemaVersion: 1, value: { rows: [{ id: AGENT }] } };
        }
        return { schemaVersion: 1, value: { rows: ids.map((id) => ({ id })) } };
      }
      return true;
    },
    async send(method: string, params?: Record<string, unknown>) {
      sends.push({ method, params });
      return {};
    },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
  return { client, evaluates, sends };
}

function escapeSends(sends: Array<{ method: string; params?: Record<string, unknown> }>): number {
  return sends.filter((s) => s.method === 'Input.dispatchKeyEvent' && s.params?.key === 'Escape').length;
}

const fast = { sleep: async () => undefined, timeoutMs: 30, pollMs: 1 };

describe('deleteAgent', () => {
  it('returns true on the happy path', async () => {
    const { client, sends } = makeClient({});
    await expect(deleteAgent(client, AGENT, fast)).resolves.toBe(true);
    expect(escapeSends(sends)).toBe(0);
  });

  it('returns false when no Delete menuitem appears and dismisses the menu', async () => {
    const { client, sends } = makeClient({ hasDelete: false });
    await expect(deleteAgent(client, AGENT, fast)).resolves.toBe(false);
    expect(escapeSends(sends)).toBeGreaterThan(0);
  });

  it('returns false when the roster still contains the id after the poll budget', async () => {
    const { client, sends } = makeClient({ gone: false });
    await expect(deleteAgent(client, AGENT, fast)).resolves.toBe(false);
    expect(escapeSends(sends)).toBeGreaterThan(0);
  });

  it('returns false when the confirm dialog never appears and dismisses the menu', async () => {
    const { client, sends } = makeClient({ dialog: false });
    await expect(deleteAgent(client, AGENT, fast)).resolves.toBe(false);
    expect(escapeSends(sends)).toBeGreaterThan(0);
  });

  it('returns false when the agent row is not present', async () => {
    const { client, sends } = makeClient({ rowPresent: false });
    await expect(deleteAgent(client, AGENT, fast)).resolves.toBe(false);
    expect(escapeSends(sends)).toBeGreaterThan(0);
  });

  it('throws on a non-UUID id before any evaluate', async () => {
    const { client, evaluates, sends } = makeClient({});
    await expect(deleteAgent(client, 'not-a-uuid', fast)).rejects.toThrow(/unsafe agent id/);
    expect(evaluates).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe('dismissMenu', () => {
  it('sends CDP Escape keyDown and keyUp', async () => {
    const { client, sends } = makeClient({});
    await dismissMenu(client);
    expect(sends.map((s) => s.params?.type)).toEqual(['rawKeyDown', 'keyUp']);
    expect(sends.every((s) => s.params?.key === 'Escape')).toBe(true);
  });
});

describe('clickMenuItem', () => {
  it('returns false when no open menus exist', async () => {
    const client: CdpLike = {
      async evaluate() { return false; },
      async send() { return {}; },
      on() { return () => undefined; },
      async close() {},
    };
    await expect(clickMenuItem(client, 'Delete')).resolves.toBe(false);
  });
});

const NEW_BOT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const OTHER_BOT = 'cccccccc-dddd-4eee-8fff-000000000000';

function makeCreateClient(script: {
  hasNewChat?: boolean;
  hasInput?: boolean;
  hasCreateButton?: boolean;
  newBotAppears?: boolean;
  barAlreadyOpen?: boolean;
  extraNewRow?: { id: string; name: string };
  existing?: Array<{ id: string; name?: string }>;
}): { client: CdpLike; evaluates: string[]; sends: Array<{ method: string; params?: Record<string, unknown> }> } {
  const evaluates: string[] = [];
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let created = false;
  const existing = script.existing ?? [{ id: AGENT, name: 'Old' }];
  const client: CdpLike = {
    async evaluate(expression: string) {
      evaluates.push(expression);
      if (expression.includes('listClientPersistenceKeys')) return KEYS;
      if (expression.includes('roster.last-roster')) {
        const rows = [...existing];
        if (created && script.newBotAppears !== false) {
          if (script.extraNewRow) rows.push(script.extraNewRow);
          rows.push({ id: NEW_BOT, name: 'Inbox' });
        }
        return { schemaVersion: 1, value: { rows } };
      }
      if (expression.includes('Close dialog') || expression.includes('Cancel')) return true;
      if (expression.includes('New Bot')) return script.hasNewChat !== false;
      if (expression.includes('Bot name')) {
        if (script.barAlreadyOpen) return true;
        return script.hasInput !== false;
      }
      if (expression.includes('const label = "Create"')) {
        if (script.hasCreateButton === false) return false;
        created = true;
        return true;
      }
      return true;
    },
    async send(method: string, params?: Record<string, unknown>) {
      sends.push({ method, params });
      return {};
    },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
  return { client, evaluates, sends };
}

function dismissed(
  sends: Array<{ method: string; params?: Record<string, unknown> }>,
  evaluates: string[],
): boolean {
  return escapeSends(sends) > 0 || evaluates.some((e) => e.includes('Close dialog') || e.includes('Cancel'));
}

describe('createAgent', () => {
  it('returns the new Bot id on the happy path without dismissing', async () => {
    const { client, sends, evaluates } = makeCreateClient({});
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBe(NEW_BOT);
    expect(dismissed(sends, evaluates)).toBe(false);
  });

  it('returns null when New chat is missing and dismisses the bar', async () => {
    const { client, sends, evaluates } = makeCreateClient({ hasNewChat: false, hasInput: false });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBeNull();
    expect(dismissed(sends, evaluates)).toBe(true);
  });

  it('proceeds when the new-chat bar is already open', async () => {
    const { client } = makeCreateClient({ hasNewChat: false, barAlreadyOpen: true });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBe(NEW_BOT);
  });

  it('returns null when the Search or create input is missing and dismisses', async () => {
    const { client, sends, evaluates } = makeCreateClient({ hasInput: false });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBeNull();
    expect(dismissed(sends, evaluates)).toBe(true);
  });

  it('returns null when the Create named Bot button never appears and dismisses', async () => {
    const { client, sends, evaluates } = makeCreateClient({ hasCreateButton: false });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBeNull();
    expect(dismissed(sends, evaluates)).toBe(true);
  });

  it('returns null when no new roster id appears after the poll budget and dismisses', async () => {
    const { client, sends, evaluates } = makeCreateClient({ newBotAppears: false });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBeNull();
    expect(dismissed(sends, evaluates)).toBe(true);
  });

  it('prefers the new roster row whose name matches the requested title', async () => {
    const { client } = makeCreateClient({
      extraNewRow: { id: OTHER_BOT, name: 'Other' },
    });
    await expect(createAgent(client, 'Inbox', fast)).resolves.toBe(NEW_BOT);
  });

  it('returns null for a blank name without evaluating', async () => {
    const { client, evaluates, sends } = makeCreateClient({});
    await expect(createAgent(client, '   ', fast)).resolves.toBeNull();
    expect(evaluates).toEqual([]);
    expect(sends).toEqual([]);
  });
});

const QUESTION = {
  cardId: 'gbq-help',
  prompt: 'What would you most like me to help with?',
  choices: [
    { id: 'A', label: 'A Email and calendar' },
    { id: 'B', label: 'B Coding and debugging' },
    { id: 'dismiss', label: 'Dismiss' },
  ],
  allowFreeText: true,
};

function makeQuestionClient(script: {
  cards?: typeof QUESTION[];
  clickOk?: boolean;
  freeTextOk?: boolean;
} = {}): {
  client: CdpLike;
  evaluates: string[];
  sends: Array<{ method: string; params?: Record<string, unknown> }>;
  clicks: { cardId: string; choiceId: string }[];
  freeTexts: { cardId: string; text: string }[];
} {
  const evaluates: string[] = [];
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const clicks: { cardId: string; choiceId: string }[] = [];
  const freeTexts: { cardId: string; text: string }[] = [];
  const cards = script.cards ? [...script.cards] : [QUESTION];
  const client: CdpLike = {
    async evaluate(expression: string) {
      evaluates.push(expression);
      if (expression.includes('__tierwynGrokBotQuestionScan')) return [...cards];
      if (expression.includes('__tierwynGrokBotQuestionClick')) {
        const m = expression.match(/__tierwynGrokBotQuestionClick\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        clicks.push({ cardId: args[0], choiceId: args[1] });
        if (script.clickOk === false) return false;
        cards.splice(0);
        return true;
      }
      if (expression.includes('__tierwynGrokBotQuestionFreeText')) {
        const m = expression.match(/__tierwynGrokBotQuestionFreeText\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        freeTexts.push({ cardId: args[0], text: args[1] });
        if (script.freeTextOk === false) return false;
        return true;
      }
      return null;
    },
    async send(method: string, params?: Record<string, unknown>) {
      sends.push({ method, params });
      return {};
    },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
  return { client, evaluates, sends, clicks, freeTexts };
}

describe('scanQuestionCards', () => {
  it('returns stamped cards from the page scan', async () => {
    const { client } = makeQuestionClient();
    await expect(scanQuestionCards(client)).resolves.toEqual([QUESTION]);
  });

  it('returns [] when evaluate yields nothing', async () => {
    const client: CdpLike = {
      async evaluate() { return null; },
      async send() { return {}; },
      on() { return () => undefined; },
      async close() {},
    };
    await expect(scanQuestionCards(client)).resolves.toEqual([]);
  });
});

describe('clickQuestion', () => {
  it('clicks the matching option by cardId and letter id', async () => {
    const { client, clicks } = makeQuestionClient();
    await expect(clickQuestion(client, 'gbq-help', 'A')).resolves.toBe(true);
    expect(clicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
  });

  it('clicks dismiss when choiceId is dismiss', async () => {
    const { client, clicks } = makeQuestionClient();
    await expect(clickQuestion(client, 'gbq-help', 'dismiss')).resolves.toBe(true);
    expect(clicks).toEqual([{ cardId: 'gbq-help', choiceId: 'dismiss' }]);
  });

  it('returns false when the click helper misses', async () => {
    const { client } = makeQuestionClient({ clickOk: false });
    await expect(clickQuestion(client, 'gbq-help', 'A')).resolves.toBe(false);
  });
});

describe('answerQuestionFreeText', () => {
  it('sets the custom-answer textarea and submits with Enter', async () => {
    const { client, freeTexts, sends } = makeQuestionClient();
    await expect(answerQuestionFreeText(client, 'gbq-help', 'just email')).resolves.toBe(true);
    expect(freeTexts).toEqual([{ cardId: 'gbq-help', text: 'just email' }]);
    expect(sends.some((s) => s.method === 'Input.dispatchKeyEvent' && s.params?.key === 'Enter')).toBe(true);
  });

  it('returns false and does not dispatch Enter when the textarea is missing', async () => {
    const { client, sends } = makeQuestionClient({ freeTextOk: false });
    await expect(answerQuestionFreeText(client, 'gbq-help', 'nope')).resolves.toBe(false);
    expect(sends).toEqual([]);
  });
});

describe('waitForSelectedChat', () => {
  it('polls until the target row reports data-active', async () => {
    let active = false;
    let polls = 0;
    const client: CdpLike = {
      async evaluate(expression: string) {
        if (expression.includes('dataset.active')) {
          polls += 1;
          return active;
        }
        return null;
      },
      async send() { return {}; },
      on() { return () => undefined; },
      async close() {},
    };
    const pending = waitForSelectedChat(client, AGENT, {
      sleep: async () => { active = true; },
      timeoutMs: 200,
      pollMs: 1,
    });
    await expect(pending).resolves.toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});

describe('QUESTION_SCAN_JS stamp', () => {
  it('refreshes data-tierwyn-question-id when the prompt text on the stamped node changes', () => {
    const form = {
      dataset: { tierwynQuestionId: 'gbq-stale' } as Record<string, string>,
      querySelectorAll(sel: string) {
        if (sel === 'button') return [{ innerText: 'A Email', textContent: 'A Email' }];
        return [];
      },
      querySelector() { return null; },
      cloneNode() {
        return {
          querySelectorAll() { return []; },
          innerText: 'What is your second question?',
          textContent: 'What is your second question?',
        };
      },
    };
    const document = {
      querySelectorAll(sel: string) { return sel === 'form' ? [form] : []; },
      querySelector() { return null; },
    };
    const window: { document: typeof document; [k: string]: unknown } = { document };
    const fn = new Function('document', 'window', 'CSS', `return (${QUESTION_SCAN_JS});`);
    const cards = fn(document, window, { escape: (s: string) => s }) as { cardId: string; prompt: string }[];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.prompt).toBe('What is your second question?');
    expect(cards[0]?.cardId).not.toBe('gbq-stale');
    expect(form.dataset.tierwynQuestionId).toBe(cards[0]?.cardId);
    expect(form.dataset.tierwynQuestionId).toMatch(/^gbq-/);
  });
});

type ApprovalScanCard = { cardId: string; prompt: string; choices: { id: string; label: string }[] };

function makeApprovalCard(opts: {
  labels: string[];
  headline?: string;
  dataset?: Record<string, string>;
}) {
  const labels = opts.labels;
  const buttons = labels.map((innerText) => ({
    innerText,
    textContent: innerText,
    parentElement: null as unknown,
  }));
  const card = {
    parentElement: null as unknown,
    dataset: { ...(opts.dataset ?? {}) } as Record<string, string>,
    innerText: `${opts.headline ?? 'Allow Grok Bot and all Bots to run commands on your local computer?'} ${labels.join(' ')}`,
    querySelectorAll(sel: string) {
      return sel === 'button' ? buttons : [];
    },
  };
  for (const b of buttons) b.parentElement = card;
  return { card, buttons };
}

function runApprovalScanCards(
  specs: Array<{ labels: string[]; headline?: string; dataset?: Record<string, string> }>,
): ApprovalScanCard[] {
  const body = {};
  const built = specs.map((s) => makeApprovalCard(s));
  for (const { card } of built) card.parentElement = body;
  const allButtons = built.flatMap((b) => b.buttons);
  const document = {
    body,
    documentElement: body,
    querySelectorAll(sel: string) {
      return sel === 'button' ? allButtons : [];
    },
  };
  const window: { document: typeof document; [k: string]: unknown } = { document };
  class MutationObserver { observe() { /* page-install no-op in unit tests */ } }
  const fn = new Function('document', 'window', 'CSS', 'MutationObserver', `return (${APPROVAL_SCAN_JS});`);
  return fn(document, window, { escape: (s: string) => s }, MutationObserver) as ApprovalScanCard[];
}

function runApprovalScan(labels: string[]): ApprovalScanCard[] {
  return runApprovalScanCards([{ labels }]);
}

describe('APPROVAL_SCAN_JS Never / Deny', () => {
  it('classifies Never as deny so a live Always allow / Allow once / Never card is visible', () => {
    const cards = runApprovalScan(['Always allow', 'Allow once', 'Never']);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.choices.map((c) => c.id)).toEqual(expect.arrayContaining(['allow_once', 'deny', 'always_allow']));
    expect(cards[0]?.choices.find((c) => c.id === 'deny')?.label).toBe('Never');
  });

  it('still classifies a Deny button as deny', () => {
    const cards = runApprovalScan(['Always allow', 'Allow once', 'Deny']);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.choices.some((c) => c.id === 'deny')).toBe(true);
    expect(cards[0]?.choices.find((c) => c.id === 'deny')?.label).toBe('Deny');
  });

  it('strips Never/Deny from the prompt and keeps the headline', () => {
    const neverCards = runApprovalScan(['Always allow', 'Allow once', 'Never']);
    expect(neverCards[0]?.prompt).toMatch(/Allow Grok Bot/i);
    expect(neverCards[0]?.prompt).not.toMatch(/\bNever\b/i);
    const denyCards = runApprovalScan(['Always allow', 'Allow once', 'Deny']);
    expect(denyCards[0]?.prompt).not.toMatch(/\bDeny\b/i);
  });
});

describe('APPROVAL_SCAN_JS unique ids', () => {
  const never = ['Always allow', 'Allow once', 'Never'];

  it('gives two Never cards with the same headline different cardIds', () => {
    const cards = runApprovalScanCards([
      { labels: never, headline: 'Grok Bot wants approval' },
      { labels: never, headline: 'Grok Bot wants approval' },
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.cardId).toMatch(/^gb-\d+-\d+$/);
    expect(cards[1]?.cardId).toMatch(/^gb-\d+-\d+$/);
    expect(cards[0]?.cardId).not.toBe(cards[1]?.cardId);
  });

  it('keeps the same cardId when the same element is scanned again', () => {
    const built = makeApprovalCard({ labels: never, headline: 'Grok Bot wants approval' });
    const body = {};
    built.card.parentElement = body;
    const document = {
      body,
      documentElement: body,
      querySelectorAll(sel: string) {
        return sel === 'button' ? built.buttons : [];
      },
    };
    const window: { document: typeof document; [k: string]: unknown } = { document };
    class MutationObserver { observe() { /* page-install no-op in unit tests */ } }
    const fn = new Function('document', 'window', 'CSS', 'MutationObserver', `return (${APPROVAL_SCAN_JS});`);
    const first = fn(document, window, { escape: (s: string) => s }, MutationObserver) as ApprovalScanCard[];
    const second = fn(document, window, { escape: (s: string) => s }, MutationObserver) as ApprovalScanCard[];
    expect(first[0]?.cardId).toMatch(/^gb-\d+-\d+$/);
    expect(second[0]?.cardId).toBe(first[0]?.cardId);
    expect(built.card.dataset.tierwynApprovalId).toBe(first[0]?.cardId);
  });

  it('skips a card that was marked as answered', () => {
    const built = makeApprovalCard({ labels: never, headline: 'Grok Bot wants approval' });
    built.card.dataset.tierwynApprovalAnswered = 'true';
    const body = {};
    built.card.parentElement = body;
    const document = {
      body,
      documentElement: body,
      querySelectorAll(sel: string) {
        return sel === 'button' ? built.buttons : [];
      },
    };
    const window: { document: typeof document; [k: string]: unknown } = { document };
    class MutationObserver { observe() { /* page-install no-op in unit tests */ } }
    const fn = new Function('document', 'window', 'CSS', 'MutationObserver', `return (${APPROVAL_SCAN_JS});`);
    const cards = fn(document, window, { escape: (s: string) => s }, MutationObserver) as ApprovalScanCard[];
    expect(cards).toHaveLength(0);
  });

  it('re-stamps data-tierwyn-approval-id when the card prompt/content key changes', () => {
    const labels = never;
    const buttons = labels.map((innerText) => ({
      innerText,
      textContent: innerText,
      parentElement: null as unknown,
    }));
    const card = {
      parentElement: null as unknown,
      dataset: { tierwynApprovalId: 'gb-stale' } as Record<string, string>,
      innerText: `A different permission this time ${labels.join(' ')}`,
      querySelectorAll(sel: string) {
        return sel === 'button' ? buttons : [];
      },
    };
    for (const b of buttons) b.parentElement = card;
    const body = {};
    card.parentElement = body;
    const document = {
      body,
      documentElement: body,
      querySelectorAll(sel: string) {
        return sel === 'button' ? buttons : [];
      },
    };
    const window: { document: typeof document; [k: string]: unknown } = { document };
    class MutationObserver { observe() { /* page-install no-op in unit tests */ } }
    const fn = new Function('document', 'window', 'CSS', 'MutationObserver', `return (${APPROVAL_SCAN_JS});`);
    const cards = fn(document, window, { escape: (s: string) => s }, MutationObserver) as ApprovalScanCard[];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.cardId).not.toBe('gb-stale');
    expect(cards[0]?.cardId).toMatch(/^gb-/);
    expect(card.dataset.tierwynApprovalId).toBe(cards[0]?.cardId);
  });
});

describe('attachComposerFiles', () => {
  const fast = { sleep: async () => undefined, timeoutMs: 30, pollMs: 1 };

  function fileClient(opts: { nodeId?: number; staged?: boolean } = {}) {
    const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client: CdpLike = {
      async evaluate() { return opts.staged !== false; },
      async send(method, params) {
        sends.push({ method, params });
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: opts.nodeId ?? 2 };
        return {};
      },
      on() { return () => undefined; },
      async close() {},
    };
    return { client, sends };
  }

  it('sets files on the composer input and returns ok when staging is ready', async () => {
    const { client, sends } = fileClient({ staged: true });
    await expect(attachComposerFiles(client, ['/tmp/a.txt'], ['a.txt'], fast)).resolves.toBe('ok');
    expect(sends.some((s) => s.method === 'DOM.setFileInputFiles' && (s.params?.files as string[])[0] === '/tmp/a.txt')).toBe(true);
  });

  it('returns missing when the file input is absent', async () => {
    const { client } = fileClient({ nodeId: 0 });
    await expect(attachComposerFiles(client, ['/tmp/a.txt'], ['a.txt'], fast)).resolves.toBe('missing');
  });

  it('returns timeout when staging never completes', async () => {
    const { client } = fileClient({ staged: false });
    await expect(attachComposerFiles(client, ['/tmp/a.txt'], ['a.txt'], fast)).resolves.toBe('timeout');
  });
});

describe('readAgentState and prefetchAgentReplica', () => {
  it('evaluates sidebar/header selectors and global SVG mark source id', async () => {
    const evaluates: string[] = [];
    const client: CdpLike = {
      async evaluate(expression: string) {
        evaluates.push(expression);
        return 'working';
      },
      async send() { return {}; },
      on() { return () => undefined; },
      async close() {},
    };
    await expect(readAgentState(client, AGENT)).resolves.toBe('working');
    expect(evaluates[0]).toContain(`sand-agent-mark-source-${AGENT}`);
  });

  it('prefetchAgentReplica dispatches pointerover/mouseover without clicking', async () => {
    const evaluates: string[] = [];
    const client: CdpLike = {
      async evaluate(expression: string) {
        evaluates.push(expression);
        return true;
      },
      async send() { return {}; },
      on() { return () => undefined; },
      async close() {},
    };
    await expect(prefetchAgentReplica(client, AGENT)).resolves.toBe(true);
    expect(evaluates[0]).toContain('pointerover');
    expect(evaluates[0]).toContain('mouseover');
    expect(evaluates[0]).not.toContain('el.click()');
  });
});
