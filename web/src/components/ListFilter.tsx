import { useLayoutEffect, useRef, useState } from "react";

import { IconFilter, IconSearch, IconX } from "./Icons";

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Collapsible in-page filter for list views.
 *
 * It only narrows entries the client already loaded — nothing is sent to the
 * server — so the count spells that out.
 *
 * Collapsed (default) renders no bar at all, so it costs no vertical space:
 * only a Filter button sits beside the first entry, on a sticky, transparent,
 * zero-height layer that does not move with the list and does not swallow
 * clicks (`pointer-events-none` on the layer, enabled on the button). The
 * parent must be `position: relative` and start at the first entry's top. When
 * the pane leaves enough gutter to the left of the list (the usual wide-desktop
 * case) the button floats there; on a narrow pane, where that gutter does not
 * exist, it falls back to a compact row above the list so it is never clipped.
 *
 * Expanding hides the button and renders the full-width field in flow, which
 * takes space and carries its own hide button. Hiding clears the query so
 * entries never stay silently filtered.
 */
export function ListFilter({
  value,
  onChange,
  placeholder = "Filter loaded entries…",
  matched,
  total,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Entries matching the current filter, out of `total` loaded entries. */
  matched?: number;
  total?: number;
  /** Classes for the expanded bar (in flow, so it pushes the list down). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [inGutter, setInGutter] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const active = value.trim().length > 0;

  // Measure the gutter left of the list so the floating button sits beside the
  // first entry instead of being clipped by the scroll container.
  useLayoutEffect(() => {
    if (open) return;
    const wrapper = wrapperRef.current;
    const parent = wrapper?.parentElement;
    if (!wrapper || !parent) return;
    const scroller = findScrollParent(wrapper);
    const measure = () => {
      const button = wrapper.firstElementChild as HTMLElement | null;
      const buttonWidth = button?.offsetWidth ?? 0;
      const gutterLeft = scroller?.getBoundingClientRect().left ?? 0;
      const available =
        parent.getBoundingClientRect().left - gutterLeft;
      setInGutter(available >= buttonWidth + 10);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (scroller) observer.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  if (!open) {
    return (
      <div
        ref={wrapperRef}
        className={
          inGutter
            ? "pointer-events-none sticky top-0 z-10 h-0"
            : "pb-2"
        }
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label="Filter loaded entries"
          title="Filter the entries already loaded in this view"
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-1.5 py-1 font-mono text-[14px] text-muted transition hover:border-line hover:bg-white/60 hover:text-ink ${
            inGutter ? "pointer-events-auto absolute right-full top-0 mr-3" : ""
          }`}
        >
          <IconFilter className="h-3.5 w-3.5" />
          <span>Filter</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-line bg-canvas/90 px-2 py-1.5 shadow-panel backdrop-blur-sm ${className}`}
    >
      <label className="relative inline-flex min-w-0 flex-1 items-center rounded-lg border border-line bg-white/60 transition focus-within:border-accent/60 focus-within:bg-white">
        <IconSearch className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-faint" />
        <input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onChange("");
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent py-1 pl-7 pr-7 font-mono text-[14px] text-ink outline-none placeholder:text-faint"
        />
        {active && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute right-1.5 rounded p-0.5 text-faint transition hover:text-ink"
            aria-label="Clear filter"
          >
            <IconX className="h-3 w-3" />
          </button>
        )}
      </label>

      {active && matched !== undefined && total !== undefined && (
        <span className="shrink-0 font-mono text-[14px] text-faint">
          {matched} of {total} loaded
        </span>
      )}

      <button
        type="button"
        onClick={() => {
          onChange("");
          setOpen(false);
        }}
        aria-expanded
        aria-label="Hide filter"
        title="Hide filter"
        className="shrink-0 rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
      >
        <IconX className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
