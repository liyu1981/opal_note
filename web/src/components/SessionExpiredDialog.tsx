import { IconRefresh } from "./Icons";

const TITLE = "Session expired";
const BODY =
  "This tab has been open for a while and its server session has expired. Refresh the page to start a new session.";
const HINT = "Unsaved changes that were not autosaved will be lost.";

function refreshPage() {
  window.location.reload();
}

function RefreshButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={refreshPage}
      className={`inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent ${className}`}
    >
      <IconRefresh className="h-3.5 w-3.5" />
      Refresh page
    </button>
  );
}

/**
 * Blocking dialog shown when an API call is rejected after the app had a
 * session. A reload is the only recovery: the client cannot mint a new cookie
 * without the server token.
 */
export function SessionExpiredDialog() {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
      role="presentation"
    >
      <div
        className="animate-fade-up w-full max-w-md rounded-2xl border border-line bg-canvas p-5 shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
        aria-describedby="session-expired-body"
      >
        <p className="text-[14px] font-semibold uppercase tracking-[0.16em] text-warning">
          {TITLE}
        </p>
        <h2
          id="session-expired-title"
          className="mt-1.5 font-serif text-xl font-semibold leading-tight text-ink"
        >
          Refresh this page to reconnect
        </h2>
        <p
          id="session-expired-body"
          className="mt-2 font-mono text-[14px] leading-relaxed text-muted"
        >
          {BODY}
        </p>
        <p className="mt-1.5 font-mono text-[14px] leading-relaxed text-faint">
          {HINT}
        </p>
        <div className="mt-4 flex justify-end">
          <RefreshButton />
        </div>
      </div>
    </div>
  );
}

/** Non-modal variant used when the connection is lost before the dialog mounts. */
export function SessionExpiredPanel() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-white/70 p-6 shadow-panel">
        <p className="text-[14px] font-semibold uppercase tracking-[0.16em] text-warning">
          {TITLE}
        </p>
        <h1 className="mt-2 font-serif text-2xl text-ink">
          Refresh this page to reconnect
        </h1>
        <p className="mt-2 break-words rounded-lg bg-panel px-3 py-2 font-mono text-[14px] text-ink-soft">
          {BODY}
        </p>
        <div className="mt-5">
          <RefreshButton />
        </div>
      </div>
    </div>
  );
}
