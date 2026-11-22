import { describe, it, expect } from 'vitest';
import {
  SELECTORS, probeSelectors, APPROVAL_CHOICES, STOP_NOW, DELETE_MENU_ITEM,
  NEW_BOT_BUTTON, CREATE_BOT_MENU_ITEM, CREATE_BOT_DIALOG, CREATE_BOT_NAME_INPUT,
  CREATE_BOT_SUBMIT_LABEL, CREATE_BOT_CANCEL_LABEL, CLOSE_CREATE_BOT_DIALOG,
  agentMarkSourceId,
} from './selectors.js';

describe('SELECTORS', () => {
  it('has ordered non-empty fallbacks for composer, sendButton, fileInput, and approvalCard', () => {
    for (const role of ['composer', 'sendButton', 'fileInput', 'approvalCard'] as const) {
      const list = SELECTORS[role];
      expect(list.length).toBeGreaterThanOrEqual(1);
      for (const sel of list) {
        expect(sel.trim().length).toBeGreaterThan(0);
        expect(sel).not.toMatch(/data-testid/);
      }
    }
  });

  it('leads with the live-verified composer selector', () => {
    expect(SELECTORS.composer[0]).toContain('sand-prompt-field');
    expect(SELECTORS.composer[0]).toContain('role="textbox"');
  });

  it('names the live-verified Delete menu item', () => {
    expect(DELETE_MENU_ITEM).toBe('Delete');
  });
});

describe('probeSelectors', () => {
  it('returns the first matching selector per role', () => {
    const resolved = probeSelectors((sel) => sel.includes('sand-prompt-field') || sel.includes('Send'));
    expect(resolved.composer).toContain('sand-prompt-field');
    expect(resolved.sendButton).toBeTruthy();
  });

  it('returns null for a role when nothing matches', () => {
    const resolved = probeSelectors(() => false);
    expect(resolved.composer).toBeNull();
    expect(resolved.sendButton).toBeNull();
    expect(resolved.approvalCard).toBeNull();
  });
});

describe('approval constants', () => {
  it('exposes Allow once / Never / Always allow and the Stop now message', () => {
    expect(STOP_NOW).toBe('Stop now');
    expect(APPROVAL_CHOICES.map((c) => c.id)).toEqual(['allow_once', 'deny', 'always_allow']);
    expect(APPROVAL_CHOICES.find((c) => c.id === 'deny')?.label).toBe('Never');
  });
});

describe('create-Bot and mark selectors (v0.78.1)', () => {
  it('names the live-verified New Bot / Create a Bot dialog controls', () => {
    expect(NEW_BOT_BUTTON).toBe('button[aria-label="New Bot"]');
    expect(CREATE_BOT_MENU_ITEM).toBe('Create a Bot');
    expect(CREATE_BOT_DIALOG).toContain('.sand-create-bot-dialog');
    expect(CREATE_BOT_NAME_INPUT).toContain('input[aria-label="Bot name"]');
    expect(CREATE_BOT_SUBMIT_LABEL).toBe('Create');
    expect(CREATE_BOT_CANCEL_LABEL).toBe('Cancel');
    expect(CLOSE_CREATE_BOT_DIALOG).toContain('button[aria-label="Close dialog"]');
  });

  it('builds the global SVG mark source id for a Bot UUID and rejects unsafe ids', () => {
    expect(agentMarkSourceId('8c236467-9550-4bb2-bb9d-80938bc7e5f6'))
      .toBe('sand-agent-mark-source-8c236467-9550-4bb2-bb9d-80938bc7e5f6');
    expect(() => agentMarkSourceId('not a uuid')).toThrow(/unsafe agent id/);
  });
});
