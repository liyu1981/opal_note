import { useEffect, useState, type FormEvent } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { IconCheck, IconSettings, IconX } from "./Icons";
import {
  refreshAtom,
  saveTokenAtom,
  settingsOpenAtom,
  tokenAtom,
} from "../state/atoms";

type TestStatus = "idle" | "testing" | "ok" | "error";

export function SettingsDialog() {
  const open = useAtomValue(settingsOpenAtom);
  const setOpen = useSetAtom(settingsOpenAtom);
  const token = useAtomValue(tokenAtom);
  const saveToken = useSetAtom(saveTokenAtom);
  const refresh = useSetAtom(refreshAtom);

  const [draft, setDraft] = useState(token);
  const [status, setStatus] = useState<TestStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(token);
    setStatus("idle");
    setMessage(null);
  }, [open, token]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  async function connect(event: FormEvent) {
    event.preventDefault();
    saveToken(draft.trim());
    setStatus("testing");
    setMessage(null);
    try {
      const health = await api.health();
      await api.listNotebooks();
      setStatus("ok");
      setMessage(
        `Connected to Opal Note ${health.version} · engine ${health.status}`,
      );
      refresh();
    } catch (cause) {
      setStatus("error");
      setMessage(
        cause instanceof Error ? cause.message : "Could not reach the server",
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="animate-fade-up w-full max-w-md rounded-2xl border border-line bg-canvas p-5 shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-panel text-ink-soft">
            <IconSettings className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="settings-title"
              className="font-serif text-xl leading-tight text-ink"
            >
              Connection
            </h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
              The client is stateless: notes, links, tags and the search index
              all live on the server. This browser only remembers which note is
              open.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink"
            aria-label="Close"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={connect} className="mt-4">
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
            API token
          </label>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Leave empty if OPALNOTE_TOKEN is not set"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-lg border border-line bg-white/70 px-2.5 py-2 font-mono text-xs outline-none transition focus:border-accent"
          />
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
            Stored in this browser's localStorage and sent as{" "}
            <code className="rounded bg-panel px-1 py-0.5 font-mono text-[10px]">
              Authorization: Bearer …
            </code>
            . The server reads it from{" "}
            <code className="rounded bg-panel px-1 py-0.5 font-mono text-[10px]">
              OPALNOTE_TOKEN
            </code>
            .
          </p>

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={status === "testing"}
              className="rounded-lg bg-ink px-3.5 py-2 text-xs font-medium text-canvas transition hover:bg-ink-soft disabled:opacity-50"
            >
              {status === "testing" ? "Testing…" : "Save & test"}
            </button>
            {token && (
              <button
                type="button"
                onClick={() => {
                  saveToken("");
                  setDraft("");
                  setStatus("idle");
                  setMessage("Token cleared.");
                }}
                className="rounded-lg border border-line px-3 py-2 text-xs text-muted transition hover:bg-panel"
              >
                Clear token
              </button>
            )}
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
              mnesticdb · rocksdb
            </span>
          </div>

          {message && (
            <p
              className={`mt-3 flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${
                status === "ok"
                  ? "bg-mint/10 text-mint"
                  : "bg-danger/10 text-danger"
              }`}
            >
              {status === "ok" && (
                <IconCheck className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span className="break-words">{message}</span>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
