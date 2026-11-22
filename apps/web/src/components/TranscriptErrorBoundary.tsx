import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Clear the fallback when the operator switches conversation. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Stops a transcript render throw from unmounting the whole SPA (black page).
 * Must be a class component — React error boundaries have no hook form.
 */
export class TranscriptErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[transcript]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="transcript-unsafe-placeholder" role="alert">
        <h3>Transcript failed to render</h3>
        <p>
          {this.state.error.message || 'An error while painting this conversation took the pane down. The rest of the app is still running.'}
        </p>
        <div className="transcript-unsafe-actions">
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
