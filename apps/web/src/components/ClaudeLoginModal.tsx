import { useCallback, useState, type FormEvent } from 'react';
import type { RemoteHostLoginState } from '@tierwyn/shared';
import type { LoginActions } from '../remoteHostAgents.js';
import { Modal } from './Modal.js';

interface Props {
  targetName: string;
  login: RemoteHostLoginState;
  actions: LoginActions;
  onClosed: () => void;
}

export function ClaudeLoginModal({ targetName, login, actions, onClosed }: Props) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const finish = () => {
      setBusy(false);
      onClosed();
    };
    actions.cancel().then(finish, finish);
  }, [busy, actions, onClosed]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setSubmitError(null);
    actions.submitCode!(trimmed).then(
      () => {
        setCode('');
        setBusy(false);
      },
      (err: unknown) => {
        setBusy(false);
        setSubmitError(err instanceof Error ? err.message : 'could not submit the code');
      },
    );
  };

  const tryAgain = () => {
    if (busy) return;
    setBusy(true);
    setSubmitError(null);
    setCode('');
    actions.retry().then(
      () => { setBusy(false); },
      (err: unknown) => {
        setBusy(false);
        setSubmitError(err instanceof Error ? err.message : 'could not restart login');
      },
    );
  };

  let body;
  if (login?.error) {
    body = (
      <div className="claude-login-status-box claude-login-status-box--error">
        <div className="claude-login-status-icon claude-login-status-icon--error">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="claude-login-status-content">
          <div className="claude-login-status-title">Sign-in failed</div>
          <p className="claude-login-status-text">{login.error}</p>
        </div>
        <button type="button" className="modal-btn primary claude-login-retry-btn" disabled={busy} onClick={tryAgain}>
          {busy ? 'Retrying…' : 'Try again'}
        </button>
      </div>
    );
  } else if (login?.codeSubmitted) {
    body = (
      <div className="claude-login-status-box claude-login-status-box--verifying">
        <div className="claude-login-spinner" aria-hidden="true" />
        <div className="claude-login-status-content">
          <div className="claude-login-status-title">Verifying code…</div>
          <p className="claude-login-status-text">
            Completing authentication on <span className="claude-login-host-name">{targetName}</span>. This may take a few moments.
          </p>
        </div>
      </div>
    );
  } else if (login?.url) {
    body = (
      <>
        <div className="claude-login-intro">
          Sign in with your Anthropic account to authorize Claude Code on <span className="claude-login-host-name">{targetName}</span>.
        </div>
        <div className="claude-login-steps">
          <div className="claude-login-step">
            <div className="claude-login-step-header">
              <span className="claude-login-step-num">1</span>
              <span className="claude-login-step-title">Open Anthropic sign-in</span>
            </div>
            <p className="claude-login-step-desc">
              Open the authorization page in your browser and sign in to grant access.
            </p>
            <a
              href={login.url}
              target="_blank"
              rel="noopener noreferrer"
              className="claude-login-open-btn"
            >
              <span>Open Claude sign-in</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>

          <div className="claude-login-step">
            <div className="claude-login-step-header">
              <span className="claude-login-step-num">2</span>
              <span className="claude-login-step-title">Paste verification code</span>
            </div>
            <form onSubmit={submit} className="claude-login-form">
              <label htmlFor="claude-auth-code" className="modal-label claude-login-label">
                Sign-in code
              </label>
              <div className="claude-login-input-row">
                <input
                  id="claude-auth-code"
                  className="modal-input claude-login-input"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Sign-in code"
                  placeholder="Paste code (e.g. code#state)…"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  type="submit"
                  className="modal-btn primary claude-login-submit-btn"
                  disabled={busy || !code.trim()}
                >
                  {busy ? 'Submitting…' : 'Submit'}
                </button>
              </div>
              <span className="claude-login-helper">
                Sign in, copy the code Claude shows, and paste it here.
              </span>
            </form>
          </div>
        </div>
      </>
    );
  } else {
    body = (
      <div className="claude-login-status-box claude-login-status-box--starting">
        <div className="claude-login-spinner" aria-hidden="true" />
        <div className="claude-login-status-content">
          <div className="claude-login-status-title">Starting sign-in…</div>
          <p className="claude-login-status-text">
            Requesting authorization URL from <span className="claude-login-host-name">{targetName}</span>…
          </p>
        </div>
      </div>
    );
  }

  return (
    <Modal
      title="Log in to Claude"
      className="claude-login-modal"
      onClose={cancel}
      footer={(
        <div className="modal-footer">
          <button type="button" className="modal-btn" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    >
      {body}
      {submitError ? (
        <div className="claude-login-error-banner" role="alert">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{submitError}</span>
        </div>
      ) : null}
    </Modal>
  );
}
