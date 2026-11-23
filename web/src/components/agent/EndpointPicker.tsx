import { useCallback, useEffect, useId, useRef, useState } from "react";

import { IconCheck, IconChevron } from "../Icons";

/** OpenAI-compatible endpoints people reach for first (checked 2026-11). */
export const ENDPOINT_PRESETS = [
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "OpenCode Zen", url: "https://opencode.ai/zen/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1" },
] as const;

const trigger =
  "flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 text-xs transition hover:bg-muted";
// The app-wide `button:focus-visible` rule draws the focus ring; the muted
// background just makes the active row easier to follow.
const item =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted";

function sameEndpoint(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/u, "") === right.trim().replace(/\/+$/u, "");
}

/**
 * Dropdown beside the base-URL field that fills a well-known OpenAI-compatible
 * endpoint, so connecting to OpenRouter / OpenCode Zen / OpenAI / DeepSeek does
 * not require remembering the path.
 *
 * Keyboard: the trigger opens with Enter/Space/ArrowDown; ArrowUp/ArrowDown (and
 * Home/End) move through the list, Escape or Tab closes it, and picking an entry
 * returns focus to the trigger.
 */
export function EndpointPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (url: string) => void;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  const focusItem = useCallback((index: number) => {
    const count = ENDPOINT_PRESETS.length;
    const next = ((index % count) + count) % count;
    items.current[next]?.focus();
  }, []);

  // Close on a click elsewhere and when focus leaves the picker (Tab out), so
  // the menu never hangs over the form.
  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node && wrapper.current?.contains(target) === true;
    const onPointerDown = (event: MouseEvent) => {
      if (!isInside(event.target)) setOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Open on the current endpoint when the field already holds one, else the
    // first entry, so Enter-Enter fills the common case.
    const current = ENDPOINT_PRESETS.findIndex((preset) =>
      sameEndpoint(value, preset.url),
    );
    focusItem(current === -1 ? 0 : current);
  }, [open, value, focusItem]);

  return (
    <div ref={wrapper} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        className={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Fill a popular endpoint"
        title="Fill a popular endpoint"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconChevron width={14} height={14} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Popular endpoints"
          className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-md border border-border/60 bg-background p-1 shadow-panel"
          onKeyDown={(event) => {
            const last = ENDPOINT_PRESETS.length - 1;
            const active = items.current.findIndex(
              (element) => element === document.activeElement,
            );
            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                focusItem(active + 1);
                break;
              case "ArrowUp":
                event.preventDefault();
                focusItem(active <= 0 ? last : active - 1);
                break;
              case "Home":
                event.preventDefault();
                focusItem(0);
                break;
              case "End":
                event.preventDefault();
                focusItem(last);
                break;
              case "Escape":
                event.preventDefault();
                close();
                break;
              default:
            }
          }}
        >
          {ENDPOINT_PRESETS.map((preset, index) => {
            const selected = sameEndpoint(value, preset.url);
            return (
              <button
                key={preset.url}
                ref={(element) => {
                  items.current[index] = element;
                }}
                type="button"
                role="menuitem"
                className={item}
                title={preset.url}
                onClick={() => {
                  onPick(preset.url);
                  close();
                }}
              >
                <span className="flex-1 truncate">{preset.label}</span>
                {selected && (
                  <IconCheck
                    width={13}
                    height={13}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
