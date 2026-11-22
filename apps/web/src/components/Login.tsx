import { useEffect, useRef, useState } from 'react';
import { auth } from '../api.js';

interface Props {
  onAuthenticated: () => void;
  /** Re-check existing session (used by the "I'm already logged in" refresh button). */
  onRefresh?: () => Promise<unknown> | void;
  /** When false, the server has no operator secrets set — disable the form. */
  configured?: boolean;
}

export function Login({ onAuthenticated, onRefresh, configured = true }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // retryAfter > 0 means rate-limited; counts down in seconds
  const [retryAfter, setRetryAfter] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Countdown timer when rate-limited
  useEffect(() => {
    if (retryAfter <= 0) return;
    const t = setTimeout(() => setRetryAfter((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [retryAfter]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const isLocked = retryAfter > 0;
  const disabled = !configured || isLocked || loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setLoading(true);
    setError('');
    const result = await auth.login(password);
    if ('ok' in result) {
      // Browsers drop Secure cookies exactly when the page is not a secure context
      // (plain http:// to anything but localhost / 127.x / ::1 / *.localhost).
      if (!window.isSecureContext) {
        const session = await auth.session().catch(() => null);
        if (session && !session.authenticated) {
          setLoading(false);
          setError(
            'Login succeeded, but your browser dropped the session cookie (COOKIE_SECURE=true over plain HTTP). Open via HTTPS, or set COOKIE_SECURE=false in your env file and restart.',
          );
          return;
        }
      }
      setLoading(false);
      onAuthenticated();
    } else if ('retryAfter' in result && result.retryAfter) {
      setLoading(false);
      setRetryAfter(result.retryAfter);
      setError('');
    } else {
      setLoading(false);
      setError(result.error ?? 'Incorrect password');
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo login-logo">
          <span className="logo-mark" aria-hidden="true" />
          <span className="logo-text">Tierwyn</span>
        </div>

        {!configured ? (
          <div className="login-notice" aria-live="polite">
            <strong>Authentication isn’t configured yet.</strong>
            <p>
              Set <code>OPERATOR_PASSWORD_HASH</code> and <code>SESSION_SECRET</code> in your{' '}
              <code>.env</code> file, then restart the server. Generation commands are in{' '}
              <code>.env.example</code>.
            </p>
          </div>
        ) : null}

        <form onSubmit={handleSubmit}>
          <div className="login-error" aria-live="polite">
            {error}
          </div>

          <label className="login-label" htmlFor="login-pw">
            Operator password
          </label>
          <input
            ref={inputRef}
            id="login-pw"
            type="password"
            className="login-input"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            autoComplete="current-password"
          />

          <button
            type="submit"
            className="login-btn"
            disabled={disabled || password.length === 0}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {isLocked && (
            <div className="login-lock">
              Too many attempts — try again in {retryAfter}s
            </div>
          )}
        </form>

        {onRefresh && (
          <button
            type="button"
            className="login-refresh"
            onClick={async () => {
              setRefreshing(true);
              try { await onRefresh(); } finally { setRefreshing(false); }
            }}
            disabled={refreshing}
          >
            {refreshing ? 'Checking…' : 'Already logged in? Refresh session'}
          </button>
        )}
      </div>
    </div>
  );
}
