import { copyText } from '../clipboard';
import { useCallback, useState } from 'react';
import type { RemoteHostLoginState } from '@tierwyn/shared';
import type { LoginActions } from '../remoteHostAgents.js';
import { Modal } from './Modal.js';

const FALLBACK_URL = 'https://auth.openai.com/codex/device';

interface Props {
  targetName: string;
  login: RemoteHostLoginState;
  actions: LoginActions;
  onClosed: () => void;
}

export function CodexLoginModal({ targetName, login, actions, onClosed }: Props) {
  const url = login?.url || FALLBACK_URL;
  const userCode = login?.userCode;
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const finish = () => {
      setBusy(false);
      onClosed();
    };
    actions.cancel().then(finish, finish);
  }, [busy, actions, onClosed]);

  const tryAgain = () => {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    setCopied(false);
    actions.retry().then(
      () => { setBusy(false); },
      (err: unknown) => {
        setBusy(false);
        setRetryError(err instanceof Error ? err.message : 'could not restart login');
      },
    );
  };

  const copyCode = useCallback(() => {
    if (!userCode) return;
    void copyText(userCode).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => { /* ignore clipboard failure */ },
    );
  }, [userCode]);

  let body;
  if (login?.error) {
    body = (
      <div className="codex-login-status-box codex-login-status-box--error">
        <div className="codex-login-status-icon codex-login-status-icon--error">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="codex-login-status-content">
          <div className="codex-login-status-title">Sign-in failed</div>
          <p className="codex-login-status-text">{login.error}</p>
        </div>
        <button type="button" className="modal-btn primary codex-login-retry-btn" disabled={busy} onClick={tryAgain}>
          {busy ? 'Retrying…' : 'Try again'}
        </button>
      </div>
    );
  } else if (login?.codeSubmitted) {
    body = (
      <div className="codex-login-status-box codex-login-status-box--verifying">
        <div className="codex-login-spinner" aria-hidden="true" />
        <div className="codex-login-status-content">
          <div className="codex-login-status-title">Verifying…</div>
          <p className="codex-login-status-text">
            Completing authentication on <span className="codex-login-host-name">{targetName}</span>. This may take a few moments.
          </p>
        </div>
      </div>
    );
  } else if (userCode) {
    body = (
      <>
        <div className="codex-login-intro">
          Sign in with your OpenAI account to authorize Codex on <span className="codex-login-host-name">{targetName}</span>.
        </div>
        <div className="codex-login-steps">
          <div className="codex-login-step">
            <div className="codex-login-step-header">
              <span className="codex-login-step-num">1</span>
              <span className="codex-login-step-title">Open OpenAI sign-in</span>
            </div>
            <p className="codex-login-step-desc">
              Open the device authorization page in your browser and sign in to grant access.
            </p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="codex-login-open-btn"
            >
              <span>Open Codex sign-in</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>

          <div className="codex-login-step">
            <div className="codex-login-step-header">
              <span className="codex-login-step-num">2</span>
              <span className="codex-login-step-title">Enter one-time code</span>
            </div>
            <div className="codex-login-form">
              <span className="modal-label codex-login-label">
                One-time code
              </span>
              <div className="codex-login-code-row">
                <div
                  className="codex-login-code-display"
                  title="Click to copy code"
                  onClick={copyCode}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      copyCode();
                    }
                  }}
                >
                  <code className="codex-login-code">{userCode}</code>
                </div>
                <button
                  type="button"
                  className={`modal-btn ${copied ? 'primary ' : ''}codex-login-copy-btn`}
                  onClick={copyCode}
                  aria-label="Copy one-time code"
                >
                  {copied ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <span className="codex-login-helper">
                Enter this code on the authorization page to connect <span className="codex-login-host-name">{targetName}</span>.
              </span>
            </div>
          </div>

          <div className="codex-login-waiting">
            <div className="codex-login-spinner" aria-hidden="true" />
            <span>Waiting for authorization…</span>
          </div>
        </div>
      </>
    );
  } else {
    body = (
      <div className="codex-login-status-box codex-login-status-box--starting">
        <div className="codex-login-spinner" aria-hidden="true" />
        <div className="codex-login-status-content">
          <div className="codex-login-status-title">Starting sign-in…</div>
          <p className="codex-login-status-text">
            Requesting authorization code from <span className="codex-login-host-name">{targetName}</span>…
          </p>
        </div>
      </div>
    );
  }

  return (
    <Modal
      title="Log in to ChatGPT for Codex"
      className="codex-login-modal"
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
      {retryError ? (
        <div className="codex-login-error-banner" role="alert">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{retryError}</span>
        </div>
      ) : null}
    </Modal>
  );
}
