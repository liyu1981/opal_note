import { useEffect, type ReactNode } from "react";

import { IconMaximize, IconMinimize, IconX } from "../Icons";

export type LightboxProps = {
  /** Accessible name for the dialog. */
  label: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned state text, e.g. "Saved" or "Loading…". */
  status?: ReactNode;
  /** Extra header buttons, rendered before the close button. */
  actions?: ReactNode;
  /** Full-screen mode: no backdrop padding, no panel border. */
  focusMode: boolean;
  onFocusModeChange: (focusMode: boolean) => void;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Shared shell for full-window viewers: backdrop, header with a focus-mode
 * toggle, Escape-to-close and Cmd/Ctrl+Shift+F. Callers own their body and any
 * extra shortcuts (Escape exits focus mode before it closes).
 */
export function Lightbox({
  label,
  title,
  subtitle,
  status,
  actions,
  focusMode,
  onFocusModeChange,
  onClose,
  children,
}: LightboxProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (focusMode) {
          onFocusModeChange(false);
          return;
        }
        close();
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onFocusModeChange(!focusMode);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode, onClose, onFocusModeChange]);

  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 backdrop-blur-sm ${
        focusMode ? "p-0" : "p-2 sm:p-4"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        className={`flex flex-col overflow-hidden border-line bg-canvas shadow-panel ${
          focusMode
            ? "h-full w-full border-0"
            : "h-[min(64rem,96vh)] w-[min(94rem,98vw)] rounded-2xl border"
        }`}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-[18px] font-semibold text-ink">
              {title}
            </h2>
            {subtitle !== undefined && (
              <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                {subtitle}
              </p>
            )}
          </div>
          {status !== undefined && (
            <span className="shrink-0 font-mono text-[14px] text-faint">
              {status}
            </span>
          )}
          <button
            type="button"
            onClick={() => onFocusModeChange(!focusMode)}
            aria-pressed={focusMode}
            aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
            title={`${focusMode ? "Exit focus mode" : "Focus mode"} (Cmd/Ctrl+Shift+F)`}
            className="shrink-0 rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
          >
            {focusMode ? (
              <IconMinimize className="h-4 w-4" />
            ) : (
              <IconMaximize className="h-4 w-4" />
            )}
          </button>
          {actions}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
