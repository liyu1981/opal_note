import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";

import {
  SHORTCUT_COMMANDS,
  bindingLabel,
  type ShortcutCommand,
} from "../lib/shortcuts";
import { useShortcutRunner } from "../lib/useShortcutRunner";
import { settingsAtom } from "../lib/settings";
import { commandPaletteOpenAtom } from "../state/atoms";
import { IconSearch } from "./Icons";

export function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const run = useShortcutRunner();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    return SHORTCUT_COMMANDS.filter((command) => {
      if (command.id === "command.palette") return false;
      if (terms.length === 0) return true;
      const haystack =
        `${command.label} ${command.description} ${command.group}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  function execute(command: ShortcutCommand) {
    setOpen(false);
    run(command.id);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && filtered[selected]) {
      event.preventDefault();
      execute(filtered[selected]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4 pt-[12vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="animate-fade-up flex max-h-[min(34rem,76vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <IconSearch className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            aria-label="Search commands"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-sans text-[16px] text-ink outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-line px-1.5 py-0.5 font-mono text-[14px] text-faint transition hover:bg-panel hover:text-ink"
            aria-label="Close command palette"
          >
            Esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center font-sans text-[14px] text-faint">
              No matching commands.
            </p>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                ref={index === selected ? selectedRef : undefined}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => execute(command)}
                className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition ${
                  index === selected
                    ? "bg-accent-soft text-accent-strong"
                    : "text-ink hover:bg-panel"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-sans text-[14px] font-medium">
                      {command.label}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] uppercase tracking-[0.08em] text-faint">
                      {command.group}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate font-sans text-[14px] text-faint">
                    {command.description}
                  </span>
                </span>
                <kbd className="max-w-56 shrink-0 truncate rounded border border-line bg-panel/60 px-1.5 py-0.5 font-mono text-[14px] text-muted">
                  {bindingLabel(command.id, settings.keybindings)}
                </kbd>
              </button>
            ))
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2 font-mono text-[14px] text-faint">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span className="ml-auto">Esc close</span>
        </div>
      </div>
    </div>
  );
}
