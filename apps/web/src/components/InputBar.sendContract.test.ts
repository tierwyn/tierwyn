import { describe, it, expect, vi } from 'vitest';
import { sanitisePromptOptions, type PromptOptions } from '@tierwyn/shared';

describe('InputBar send contract (MAJOR-4 & MAJOR-6)', () => {
  /**
   * Models the dispatch-and-clear contract implemented in InputBar.tsx:
   *
   *   if (onSend(...) === false) return;
   *   clearAfterDispatch();
   */
  function dispatchWithClearGuard(
    onSend: () => boolean | void,
    clearAfterDispatch: () => void
  ) {
    if (onSend() === false) return;
    clearAfterDispatch();
  }

  /**
   * Models App.tsx handleSend / dispatchPrompt error handling:
   * Returns false when prompt options validation fails or staged error is present,
   * preserving the composer text and draft.
   */
  function simulateAppSend({
    text,
    agent,
    promptOptions,
    stagedError,
    showAlert,
    sendWs,
  }: {
    text: string;
    agent: string;
    promptOptions?: PromptOptions;
    stagedError?: string | null;
    showAlert: (msg: string, title?: string) => void;
    sendWs: (payload: { text: string; options?: PromptOptions }) => void;
  }): boolean | void {
    if (stagedError) {
      showAlert(stagedError, 'Prompt Options Error');
      return false;
    }
    if (promptOptions && Object.keys(promptOptions).length > 0) {
      try {
        sanitisePromptOptions(agent, promptOptions);
      } catch (err: any) {
        showAlert(err?.message || 'Invalid prompt options', 'Prompt Options Error');
        return false;
      }
    }
    sendWs({ text, options: promptOptions });
    return true;
  }

  describe('dispatch-and-clear contract', () => {
    it('does NOT clear composer or local/remote draft when onSend returns false', () => {
      const clearAfterDispatch = vi.fn();
      const onSend = vi.fn(() => false);

      dispatchWithClearGuard(onSend, clearAfterDispatch);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(clearAfterDispatch).not.toHaveBeenCalled();
    });

    it('clears composer and drafts when onSend succeeds (returns true)', () => {
      const clearAfterDispatch = vi.fn();
      const onSend = vi.fn(() => true);

      dispatchWithClearGuard(onSend, clearAfterDispatch);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(clearAfterDispatch).toHaveBeenCalledTimes(1);
    });

    it('clears composer and drafts when onSend returns void/undefined', () => {
      const clearAfterDispatch = vi.fn();
      const onSend = vi.fn(() => undefined);

      dispatchWithClearGuard(onSend, clearAfterDispatch);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(clearAfterDispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('sanitise error propagation preserves composer (MAJOR-4)', () => {
    it('returns false and prevents composer clear when prompt option value starts with dash (CLI injection guard)', () => {
      const clearAfterDispatch = vi.fn();
      const showAlert = vi.fn();
      const sendWs = vi.fn();

      const sendResult = simulateAppSend({
        text: 'Fix issue in auth module',
        agent: 'antigravity',
        promptOptions: { jsonSchema: '--malicious-flag' },
        showAlert,
        sendWs,
      });

      expect(sendResult).toBe(false);
      expect(showAlert).toHaveBeenCalledWith(
        expect.stringContaining('cannot start with "-"'),
        'Prompt Options Error'
      );
      expect(sendWs).not.toHaveBeenCalled();

      // Ensure InputBar contract preserves composer
      dispatchWithClearGuard(() => sendResult, clearAfterDispatch);
      expect(clearAfterDispatch).not.toHaveBeenCalled();
    });

    it('returns false and prevents composer clear when jsonSchema is invalid JSON', () => {
      const clearAfterDispatch = vi.fn();
      const showAlert = vi.fn();
      const sendWs = vi.fn();

      const sendResult = simulateAppSend({
        text: 'Extract structured data',
        agent: 'antigravity',
        promptOptions: { jsonSchema: '{ invalid json' },
        showAlert,
        sendWs,
      });

      expect(sendResult).toBe(false);
      expect(showAlert).toHaveBeenCalledWith(
        expect.stringContaining('valid JSON'),
        'Prompt Options Error'
      );
      expect(sendWs).not.toHaveBeenCalled();

      dispatchWithClearGuard(() => sendResult, clearAfterDispatch);
      expect(clearAfterDispatch).not.toHaveBeenCalled();
    });

    it('succeeds, sends WS, and clears composer when prompt options are valid', () => {
      const clearAfterDispatch = vi.fn();
      const showAlert = vi.fn();
      const sendWs = vi.fn();

      const sendResult = simulateAppSend({
        text: 'Extract structured data',
        agent: 'antigravity',
        promptOptions: { jsonSchema: '{"type":"object"}' },
        showAlert,
        sendWs,
      });

      expect(sendResult).toBe(true);
      expect(showAlert).not.toHaveBeenCalled();
      expect(sendWs).toHaveBeenCalledWith({
        text: 'Extract structured data',
        options: { jsonSchema: '{"type":"object"}' },
      });

      dispatchWithClearGuard(() => sendResult, clearAfterDispatch);
      expect(clearAfterDispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('staged error blocking preserves composer (MAJOR-6)', () => {
    it('returns false and aborts dispatch when stagedPromptOptionsError exists', () => {
      const clearAfterDispatch = vi.fn();
      const showAlert = vi.fn();
      const sendWs = vi.fn();

      const sendResult = simulateAppSend({
        text: 'Run tests',
        agent: 'antigravity',
        promptOptions: { mode: 'plan' },
        stagedError: 'Staged prompt options have errors: jsonSchema: Must be valid JSON',
        showAlert,
        sendWs,
      });

      expect(sendResult).toBe(false);
      expect(showAlert).toHaveBeenCalledWith(
        'Staged prompt options have errors: jsonSchema: Must be valid JSON',
        'Prompt Options Error'
      );
      expect(sendWs).not.toHaveBeenCalled();

      dispatchWithClearGuard(() => sendResult, clearAfterDispatch);
      expect(clearAfterDispatch).not.toHaveBeenCalled();
    });
  });
});
