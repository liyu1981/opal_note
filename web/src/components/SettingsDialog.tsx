import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { PluginList } from "../api/types";
import {
  FONT_PRESETS,
  FONT_ROLES,
  applySettings,
  settingsAtom,
  settingsStatusAtom,
  type AppSettings,
  type FontRole,
} from "../lib/settings";
import {
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  chordFromEvent,
  defaultBindingText,
  formatBinding,
  resolveBindings,
  type ShortcutCommand,
} from "../lib/shortcuts";
import {
  IconArrowUpRight,
  IconCheck,
  IconGithub,
  IconRefresh,
  IconSettings,
  IconX,
} from "./Icons";
import { OpalLogo } from "./OpalLogo";
import {
  journalPluginsRevisionAtom,
  refreshAtom,
  saveTokenAtom,
  settingsOpenAtom,
  shortcutRecordingAtom,
  tokenAtom,
} from "../state/atoms";

type Tab =
  | "fonts"
  | "shortcuts"
  | "connection"
  | "index"
  | "plugins"
  | "about";
type TestStatus = "idle" | "testing" | "ok" | "error";

const TABS: Array<{ id: Tab; label: string; description: string }> = [
  {
    id: "fonts",
    label: "Fonts",
    description: "Choose the typeface for each part of the workspace.",
  },
  {
    id: "shortcuts",
    label: "Keyboard",
    description: "Review and customize workspace keybindings.",
  },
  {
    id: "connection",
    label: "Connection",
    description: "Server access and authentication.",
  },
  {
    id: "index",
    label: "Index",
    description: "Rebuild the disposable Datalog index.",
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Inspect installed journal plugins and reload the data folder.",
  },
  {
    id: "about",
    label: "About",
    description: "About Opal Note and this self-hosted build.",
  },
];

export function SettingsDialog() {
  const open = useAtomValue(settingsOpenAtom);
  const setOpen = useSetAtom(settingsOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const setSettings = useSetAtom(settingsAtom);
  const syncStatus = useAtomValue(settingsStatusAtom);
  const recording = useAtomValue(shortcutRecordingAtom);
  const token = useAtomValue(tokenAtom);
  const saveToken = useSetAtom(saveTokenAtom);
  const refresh = useSetAtom(refreshAtom);

  const [tab, setTab] = useState<Tab>("fonts");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [fontStatus, setFontStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [fontError, setFontError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const saveVersion = useRef(0);

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setTokenDraft(token);
    setDirty(false);
    setFontStatus("saved");
    setFontError(null);
    setTestStatus("idle");
    setMessage(null);
    // Only reset the draft when the dialog opens; font edits update `settings`
    // while the dialog is open and must not be overwritten by this effect.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !recording) {
        if (dirty) void saveSettings(draft);
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, draft, open, recording, setOpen]);

  async function saveSettings(next: AppSettings) {
    const version = ++saveVersion.current;
    setFontStatus("saving");
    setFontError(null);
    try {
      const { persistSettings } = await import("../lib/settings");
      await persistSettings(next);
      if (version === saveVersion.current) {
        setFontStatus("saved");
        setDirty(false);
      }
    } catch (cause) {
      if (version === saveVersion.current) {
        setFontStatus("error");
        setFontError(
          cause instanceof Error ? cause.message : "Could not save settings",
        );
      }
    }
  }

  useEffect(() => {
    if (!open || !dirty) return;
    const timer = window.setTimeout(() => void saveSettings(draft), 450);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, open]);

  function updateFont(role: FontRole, patch: Partial<AppSettings["fonts"][FontRole]>) {
    const next: AppSettings = {
      ...draft,
      fonts: {
        ...draft.fonts,
        [role]: { ...draft.fonts[role], ...patch },
      },
    };
    setDraft(next);
    setSettings(next);
    applySettings(next);
    setDirty(true);
    setFontStatus("saving");
  }

  function resetFonts() {
    const next: AppSettings = {
      ...draft,
      fonts: {
        ui: { family: "Inter", google: false },
        display: { family: "JetBrains Mono", google: false },
        editor: { family: "JetBrains Mono", google: false },
        mono: { family: "JetBrains Mono", google: false },
      },
    };
    setDraft(next);
    setSettings(next);
    applySettings(next);
    setDirty(true);
    setFontStatus("saving");
  }

  function updateKeybinding(id: string, binding: string | null) {
    const keybindings = { ...draft.keybindings };
    if (binding) keybindings[id] = binding;
    else delete keybindings[id];
    const next: AppSettings = { ...draft, keybindings };
    setDraft(next);
    setSettings(next);
    setDirty(true);
    setFontStatus("saving");
  }

  function resetKeybindings() {
    const next: AppSettings = { ...draft, keybindings: {} };
    setDraft(next);
    setSettings(next);
    setDirty(true);
    setFontStatus("saving");
  }

  async function rebuildIndex() {
    if (rebuilding) return;
    setRebuilding(true);
    setTestStatus("testing");
    setMessage(null);
    try {
      const stats = await api.reindex();
      setTestStatus("ok");
      setMessage(
        `Index rebuilt from files: ${stats.notes} notes, ${stats.tags} tags, ${stats.links} links.`,
      );
      refresh();
    } catch (cause) {
      setTestStatus("error");
      setMessage(
        cause instanceof Error ? cause.message : "Could not rebuild the index",
      );
    } finally {
      setRebuilding(false);
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    saveToken(tokenDraft.trim());
    setTestStatus("testing");
    setMessage(null);
    try {
      const health = await api.health();
      await api.listNotebooks();
      setTestStatus("ok");
      setMessage(
        `Connected to Opal Note ${health.version} · engine ${health.status}`,
      );
      refresh();
    } catch (cause) {
      setTestStatus("error");
      setMessage(
        cause instanceof Error ? cause.message : "Could not reach the server",
      );
    }
  }

  if (!open) return null;

  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0]!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          if (dirty) void saveSettings(draft);
          setOpen(false);
        }
      }}
    >
      <div
        className="animate-fade-up flex h-[min(46rem,88vh)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-panel md:flex-row"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <aside className="flex shrink-0 flex-row flex-wrap gap-1 border-b border-line bg-panel/50 p-2 md:w-48 md:flex-col md:flex-nowrap md:border-b-0 md:border-r md:p-3">
          <div className="hidden items-center gap-2 px-2 pb-3 md:flex">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-accent-soft text-accent-strong">
              <IconSettings className="h-4 w-4" />
            </span>
            <span className="font-sans text-[16px] font-semibold text-ink">
              Settings
            </span>
          </div>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded px-3 py-2 text-left font-sans text-[14px] transition ${
                tab === item.id
                  ? "bg-accent-soft font-medium text-accent-strong"
                  : "text-ink-soft hover:bg-white"
              }`}
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto self-center font-mono text-[14px] text-faint md:ml-0 md:mt-auto md:self-start md:px-2">
            {syncStatus === "loading"
              ? "Loading…"
              : syncStatus === "error"
                ? "Offline"
                : "Square"}
          </span>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start gap-3 border-b border-line px-6 py-4">
            <div className="min-w-0 flex-1">
              <h2
                id="settings-title"
                className="font-serif text-[24px] font-semibold leading-tight text-ink"
              >
                {activeTab.label}
              </h2>
              <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
                {activeTab.description}
              </p>
            </div>
            {fontStatus !== "idle" && (tab === "fonts" || tab === "shortcuts") && (
              <span
                className={`mt-1 font-mono text-[14px] ${
                  fontStatus === "error" ? "text-danger" : "text-faint"
                }`}
              >
                {fontStatus === "saving"
                  ? "Saving…"
                  : fontStatus === "error"
                    ? "Save failed"
                    : "Saved"}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                if (dirty) void saveSettings(draft);
                setOpen(false);
              }}
              className="rounded p-1 text-faint transition hover:bg-panel hover:text-ink"
              aria-label="Close"
            >
              <IconX className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {tab === "fonts" && (
              <FontsTab
                settings={draft}
                onChange={updateFont}
                onReset={resetFonts}
                error={fontError}
              />
            )}
            {tab === "shortcuts" && (
              <ShortcutsTab
                settings={draft}
                onChange={updateKeybinding}
                onReset={resetKeybindings}
                error={fontError}
              />
            )}
            {tab === "connection" && (
              <ConnectionTab
                token={tokenDraft}
                setToken={setTokenDraft}
                hasToken={Boolean(token)}
                status={testStatus}
                message={message}
                onConnect={connect}
                onClear={() => {
                  saveToken("");
                  setTokenDraft("");
                  setTestStatus("idle");
                  setMessage("Token cleared.");
                }}
              />
            )}
            {tab === "index" && (
              <IndexTab
                rebuilding={rebuilding}
                status={testStatus}
                message={message}
                onRebuild={rebuildIndex}
              />
            )}
            {tab === "plugins" && <PluginsTab />}
            {tab === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function FontsTab({
  settings,
  onChange,
  onReset,
  error,
}: {
  settings: AppSettings;
  onChange: (role: FontRole, patch: Partial<AppSettings["fonts"][FontRole]>) => void;
  onReset: () => void;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      <datalist id="font-presets">
        {FONT_PRESETS.map((font) => (
          <option key={font} value={font} />
        ))}
      </datalist>

      <div className="grid gap-3 sm:grid-cols-2">
        {FONT_ROLES.map((role) => {
          const value = settings.fonts[role.id];
          return (
            <section
              key={role.id}
              className="rounded-lg border border-line bg-white p-4"
            >
              <label
                htmlFor={`font-${role.id}`}
                className="font-sans text-[14px] font-semibold text-ink"
              >
                {role.label}
              </label>
              <p className="mt-0.5 font-sans text-[14px] leading-relaxed text-faint">
                {role.description}
              </p>
              <input
                id={`font-${role.id}`}
                list="font-presets"
                value={value.family}
                onChange={(event) =>
                  onChange(role.id, { family: event.target.value })
                }
                spellCheck={false}
                autoComplete="off"
                className="mt-3 w-full rounded border border-line bg-white px-2.5 py-2 font-sans text-[14px] text-ink outline-none transition focus:border-accent"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 font-sans text-[14px] text-muted">
                  <input
                    type="checkbox"
                    checked={value.google}
                    onChange={(event) =>
                      onChange(role.id, { google: event.target.checked })
                    }
                    className="accent-accent"
                  />
                  Load from Google Fonts
                </label>
                <span className="font-mono text-[14px] text-faint">Sample</span>
              </div>
              <p
                className="mt-3 truncate font-sans text-[18px] leading-tight text-ink"
                style={{
                  fontFamily: value.family
                    ? `"${value.family.replace(/["'\\]/gu, " ")}", ${role.fallback}`
                    : role.fallback,
                }}
              >
                The quick brown fox
              </p>
            </section>
          );
        })}
      </div>

      {error && (
        <p className="rounded bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between border-t border-line pt-4">
        <p className="font-sans text-[14px] text-faint">
          Google Fonts are requested over HTTPS and cached by the browser.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-line px-3 py-1.5 font-sans text-[14px] text-muted transition hover:bg-panel hover:text-ink"
        >
          Reset to Square fonts
        </button>
      </div>
    </div>
  );
}

function ConnectionTab({
  token,
  setToken,
  hasToken,
  status,
  message,
  onConnect,
  onClear,
}: {
  token: string;
  setToken: (value: string) => void;
  hasToken: boolean;
  status: TestStatus;
  message: string | null;
  onConnect: (event: FormEvent) => void;
  onClear: () => void;
}) {
  return (
    <form onSubmit={onConnect}>
      <label className="block font-sans text-[14px] font-semibold text-ink">
        API token
      </label>
      <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
        The client is stateless. The token is stored in this browser and sent as
        an <code className="rounded bg-panel px-1 font-mono text-[14px]">Authorization: Bearer</code> header.
      </p>
      <input
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="Leave empty if OPALNOTE_TOKEN is not set"
        autoComplete="off"
        spellCheck={false}
        className="mt-3 w-full rounded border border-line bg-white px-3 py-2 font-sans text-[14px] outline-none transition focus:border-accent"
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={status === "testing"}
          className="rounded-lg bg-accent-strong px-3.5 py-2 font-sans text-[14px] font-medium text-white transition hover:bg-accent disabled:opacity-50"
        >
          {status === "testing" ? "Testing…" : "Save & test"}
        </button>
        {hasToken && (
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-line px-3 py-2 font-sans text-[14px] text-muted transition hover:bg-panel"
          >
            Clear token
          </button>
        )}
      </div>
      {message && (
        <StatusMessage status={status} message={message} />
      )}
    </form>
  );
}

function IndexTab({
  rebuilding,
  status,
  message,
  onRebuild,
}: {
  rebuilding: boolean;
  status: TestStatus;
  message: string | null;
  onRebuild: () => void;
}) {
  return (
    <div>
      <div className="rounded-lg border border-line bg-panel/50 p-4">
        <h3 className="font-sans text-[16px] font-semibold text-ink">
          Rebuild the Datalog index
        </h3>
        <p className="mt-1 max-w-xl font-sans text-[14px] leading-relaxed text-muted">
          The index is disposable. Rebuilding re-reads every markdown file and
          regenerates tags, tasks, links and the search index from disk.
        </p>
        <button
          type="button"
          onClick={onRebuild}
          disabled={rebuilding}
          className="mt-4 rounded-lg bg-accent-strong px-3.5 py-2 font-sans text-[14px] font-medium text-white transition hover:bg-accent disabled:opacity-50"
        >
          {rebuilding ? "Reindexing…" : "Rebuild index"}
        </button>
      </div>
      <p className="mt-4 font-mono text-[14px] uppercase tracking-[0.12em] text-faint">
        mnesticdb · sqlite
      </p>
      {message && <StatusMessage status={status} message={message} />}
    </div>
  );
}

function ShortcutsTab({
  settings,
  onChange,
  onReset,
  error,
}: {
  settings: AppSettings;
  onChange: (id: string, binding: string | null) => void;
  onReset: () => void;
  error: string | null;
}) {
  const setRecording = useSetAtom(shortcutRecordingAtom);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [capture, setCapture] = useState("");

  useEffect(() => {
    if (!recordingId) return;
    const targetId = recordingId;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        setCapture("");
        setRecording(false);
        return;
      }
      if (event.key === "Enter") {
        if (capture.trim()) onChange(targetId, capture.trim());
        setRecordingId(null);
        setCapture("");
        setRecording(false);
        return;
      }
      if (event.key === "Backspace") {
        setCapture((current) =>
          current.split(/\s+/u).filter(Boolean).slice(0, -1).join(" "),
        );
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      setCapture((current) => (current ? `${current} ${chord}` : chord));
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capture, onChange, recordingId, setRecording]);

  useEffect(() => {
    return () => setRecording(false);
  }, [setRecording]);

  function startRecording(id: string) {
    setCapture("");
    setRecordingId(id);
    setRecording(true);
  }

  const bindings = new Map<string, string[]>();
  for (const command of SHORTCUT_COMMANDS) {
    for (const binding of resolveBindings(command, settings.keybindings)) {
      bindings.set(binding, [...(bindings.get(binding) ?? []), command.id]);
    }
  }
  const conflicts = new Set(
    [...bindings.values()]
      .filter((ids) => ids.length > 1)
      .flat(),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-lg font-sans text-[14px] leading-relaxed text-muted">
          Click a binding to record a new chord sequence. Press Enter to save,
          Backspace to remove the last key, or Escape to cancel.
        </p>
        <button
          type="button"
          onClick={() => {
            setRecordingId(null);
            setCapture("");
            setRecording(false);
            onReset();
          }}
          className="rounded border border-line px-3 py-1.5 font-sans text-[14px] text-muted transition hover:bg-panel hover:text-ink"
        >
          Reset all shortcuts
        </button>
      </div>

      {conflicts.size > 0 && (
        <p className="rounded bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
          Some bindings are assigned more than once. The first matching command
          wins until the conflict is resolved.
        </p>
      )}

      {SHORTCUT_GROUPS.map((group) => (
        <section key={group}>
          <h3 className="mb-2 font-mono text-[14px] font-semibold uppercase tracking-[0.12em] text-faint">
            {group}
          </h3>
          <div className="overflow-hidden rounded-lg border border-line bg-white">
            {SHORTCUT_COMMANDS.filter((command) => command.group === group).map(
              (command) => (
                <ShortcutRow
                  key={command.id}
                  command={command}
                  custom={settings.keybindings[command.id]}
                  effective={resolveBindings(command, settings.keybindings)}
                  conflict={conflicts.has(command.id)}
                  recording={recordingId === command.id}
                  capture={capture}
                  onRecord={() => startRecording(command.id)}
                  onReset={() => onChange(command.id, null)}
                  onCancel={() => {
                    setRecordingId(null);
                    setCapture("");
                    setRecording(false);
                  }}
                />
              ),
            )}
          </div>
        </section>
      ))}

      {error && (
        <p className="rounded bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ShortcutRow({
  command,
  custom,
  effective,
  conflict,
  recording,
  capture,
  onRecord,
  onReset,
  onCancel,
}: {
  command: ShortcutCommand;
  custom: string | undefined;
  effective: string[];
  conflict: boolean;
  recording: boolean;
  capture: string;
  onRecord: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const label = capture
    ? capture
        .split(/\s+/u)
        .filter(Boolean)
        .map((chord) => formatBinding(chord))
        .join(" ")
    : recording
      ? "Press keys…"
      : custom
        ? formatBinding(custom)
        : effective.map(formatBinding).join(" / ");

  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-sans text-[14px] font-medium text-ink">
            {command.label}
          </span>
          {conflict && (
            <span className="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[14px] text-danger">
              conflict
            </span>
          )}
        </div>
        <p className="mt-0.5 font-sans text-[14px] leading-relaxed text-faint">
          {command.description}
        </p>
        <p className="mt-0.5 font-mono text-[14px] text-faint">
          Default: {defaultBindingText(command)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onRecord}
          className={`min-w-40 whitespace-nowrap rounded border px-2 py-1.5 font-mono text-[14px] transition ${
            recording
              ? "border-accent bg-accent-soft text-accent-strong"
              : "border-line bg-panel/40 text-ink-soft hover:bg-panel"
          }`}
        >
          {label}
        </button>
        {recording && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line px-2 py-1 font-mono text-[14px] text-faint transition hover:bg-panel hover:text-ink"
            title="Cancel recording"
          >
            Esc
          </button>
        )}
        {custom && !recording && (
          <button
            type="button"
            onClick={onReset}
            className="rounded px-2 py-1 font-sans text-[14px] text-faint transition hover:bg-panel hover:text-ink"
            title={`Reset ${command.label}`}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function PluginsTab() {
  const bumpPlugins = useSetAtom(journalPluginsRevisionAtom);
  const [data, setData] = useState<PluginList | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.listPlugins();
      setData(next);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load plugins",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function reload() {
    setReloading(true);
    setError(null);
    try {
      const next = await api.reloadPlugins();
      setData(next);
      bumpPlugins((revision) => revision + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reload plugins",
      );
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="max-w-xl font-sans text-[14px] leading-relaxed text-muted">
            Built-in plugins ship inside the binary. Add one folder per plugin
            under the data directory, with a{" "}
            <code className="rounded bg-panel px-1 font-mono text-[14px]">
              plugin.json
            </code>{" "}
            manifest and a{" "}
            <code className="rounded bg-panel px-1 font-mono text-[14px]">
              plugin.js
            </code>{" "}
            source file, then reload.
          </p>
          {data && (
            <p className="mt-2 break-all rounded border border-line bg-panel/40 px-2.5 py-1.5 font-mono text-[14px] text-ink-soft">
              {data.directory}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || reloading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-strong px-3.5 py-2 font-sans text-[14px] font-medium text-white transition hover:bg-accent disabled:opacity-50"
        >
          <IconRefresh
            className={`h-3.5 w-3.5 ${reloading ? "animate-spin" : ""}`}
          />
          {reloading ? "Reloading…" : "Reload plugins"}
        </button>
      </div>

      {error && (
        <p className="rounded bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
          {error}
        </p>
      )}

      {loading && !data ? (
        <p className="px-2 py-8 text-center font-sans text-[14px] text-faint">
          Loading plugins…
        </p>
      ) : data?.plugins.length === 0 ? (
        <p className="rounded-lg border border-line bg-white px-4 py-8 text-center font-sans text-[14px] text-faint">
          No plugins loaded.
        </p>
      ) : (
        <div className="space-y-2">
          {data?.plugins.map((plugin) => (
            <section
              key={plugin.id}
              className="rounded-lg border border-line bg-white p-4"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-sans text-[14px] font-semibold text-ink">
                      {plugin.title}
                    </h3>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[12px] uppercase tracking-[0.08em] ${
                        plugin.source === "builtin"
                          ? "bg-accent-soft text-accent-strong"
                          : "bg-mint/10 text-mint"
                      }`}
                    >
                      {plugin.source === "builtin" ? "Built-in" : "Data"}
                    </span>
                    <span className="font-mono text-[12px] text-faint">
                      {plugin.id}
                    </span>
                  </div>
                  <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
                    {plugin.description}
                  </p>
                  {plugin.path && (
                    <p className="mt-1 break-all font-mono text-[12px] text-faint">
                      {plugin.path}
                    </p>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {data && data.errors.length > 0 && (
        <section className="rounded-lg border border-danger/30 bg-danger/5 p-4">
          <h3 className="font-sans text-[14px] font-semibold text-danger">
            Load errors
          </h3>
          <div className="mt-2 space-y-2">
            {data.errors.map((item) => (
              <div key={`${item.folder}-${item.message}`}>
                <p className="font-mono text-[12px] text-danger">
                  {item.folder}
                </p>
                <p className="break-words font-sans text-[14px] leading-relaxed text-muted">
                  {item.message}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AboutTab() {
  const features = [
    {
      title: "Markdown first",
      body: "Every page is a plain .md file you can read, edit, sync, and back up without Opal Note.",
    },
    {
      title: "Self-hosted",
      body: "One Rust binary serves the API and the web client. No account, no cloud dependency.",
    },
    {
      title: "Yours to keep",
      body: "The Datalog index is rebuilt from files at any time. Delete it and nothing is lost.",
    },
  ];

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-line bg-panel/35 p-6">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <OpalLogo className="h-28 w-28 shrink-0 drop-shadow-sm" />
          <div className="min-w-0">
            <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-faint">
              Local-first knowledge vault
            </p>
            <h3 className="mt-1 font-serif text-[24px] font-semibold leading-none text-ink">
              Opal Note
            </h3>
            <p className="mt-3 max-w-xl font-sans text-[14px] leading-relaxed text-muted">
              A local markdown knowledge vault, built to be self-hosted. Files
              stay on your disk, the index is disposable, and the whole
              workspace runs from one binary.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {["Self-hosted", "Markdown-first", "Single binary"].map((label) => (
                <span
                  key={label}
                  className="rounded border border-line bg-white px-2 py-1 font-mono text-[12px] uppercase tracking-[0.08em] text-muted"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        {features.map((feature) => (
          <section
            key={feature.title}
            className="rounded-lg border border-line bg-white p-4"
          >
            <h4 className="font-sans text-[14px] font-semibold text-ink">
              {feature.title}
            </h4>
            <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
              {feature.body}
            </p>
          </section>
        ))}
      </div>

      <section className="rounded-lg border border-line bg-white p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-panel text-ink-soft">
            <IconGithub className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="font-sans text-[14px] font-semibold text-ink">
              Source code
            </h4>
            <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
              Opal Note is open source. Follow development, report issues, or
              build and run your own copy.
            </p>
            <a
              href="https://github.com/liyu1981/opal_note"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 font-sans text-[14px] font-medium text-accent-strong transition hover:text-accent"
            >
              github.com/liyu1981/opal_note
              <IconArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      <p className="border-t border-line pt-4 font-sans text-[14px] text-faint">
        Built for people who want their notes to outlive the app.
      </p>
    </div>
  );
}

function StatusMessage({
  status,
  message,
}: {
  status: TestStatus;
  message: string;
}) {
  return (
    <p
      className={`mt-3 flex items-start gap-1.5 rounded px-3 py-2 font-sans text-[14px] leading-relaxed ${
        status === "ok" ? "bg-mint/10 text-mint" : "bg-danger/10 text-danger"
      }`}
    >
      {status === "ok" && <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="break-words">{message}</span>
    </p>
  );
}
