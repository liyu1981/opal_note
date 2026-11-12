import {
  Component,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
} from "react";

import { ApiError, storeToken } from "../api/client";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches async-atom / render failures.
 *
 * A 401 or a network error gets a token form instead of a dead end, since the
 * client cannot open its settings dialog until the first query succeeds.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Opal Note render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const error = this.state.error;
    const needsConnection = error instanceof ApiError && error.status === 401;

    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-md rounded-2xl border border-line bg-white/70 p-6 shadow-panel">
          <p className="text-[14px] font-semibold uppercase tracking-[0.16em] text-danger">
            {needsConnection ? "Connection required" : "Something went wrong"}
          </p>
          <h1 className="mt-2 font-serif text-2xl text-ink">
            {needsConnection
              ? "Sign in to this notebook"
              : "The notebook could not be loaded"}
          </h1>
          <p className="mt-2 break-words rounded-lg bg-panel px-3 py-2 font-mono text-[14px] text-ink-soft">
            {error.message}
          </p>

          {needsConnection ? (
            <ConnectionForm />
          ) : (
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="rounded-lg border border-line px-3.5 py-2 text-sm text-ink-soft transition hover:bg-panel"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}

function ConnectionForm() {
  const [token, setToken] = useState("");

  function connect(event: FormEvent) {
    event.preventDefault();
    storeToken(token.trim());
    window.location.reload();
  }

  return (
    <form onSubmit={connect} className="mt-4">
      <label className="block text-[14px] font-semibold uppercase tracking-[0.16em] text-faint">
        API token
      </label>
      <input
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="Value of OPALNOTE_TOKEN"
        autoComplete="off"
        spellCheck={false}
        className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-2.5 py-2 font-mono text-[14px] outline-none focus:border-accent"
      />
      <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
        Stored in this browser only. The server compares it against{" "}
        <code className="rounded bg-panel px-1 py-0.5 font-mono text-[14px]">
          OPALNOTE_TOKEN
        </code>
        {"."}
      </p>
      <button
        type="submit"
        className="mt-3 rounded-lg bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent"
      >
        Connect
      </button>
    </form>
  );
}
