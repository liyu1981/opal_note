import { useAtom } from "jotai";

import { formatBinding } from "../lib/shortcuts";
import { shortcutSequenceAtom } from "../state/atoms";
import { IconX } from "./Icons";

export function ShortcutHud() {
  const [sequence, setSequence] = useAtom(shortcutSequenceAtom);
  if (!sequence) return null;

  const label = sequence
    .split(/\s+/u)
    .map((chord) => formatBinding(chord))
    .join(" ");

  return (
    <div
      className="fixed top-16 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-canvas/95 px-3 py-2 shadow-panel backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <span className="font-mono text-[14px] font-semibold tracking-wide text-ink">
        {label}
      </span>
      <span className="font-sans text-[14px] text-faint">
        waiting for next key
      </span>
      <button
        type="button"
        onClick={() => setSequence("")}
        className="ml-1 inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-[14px] text-muted transition hover:bg-panel hover:text-ink"
        aria-label="Cancel shortcut"
        title="Cancel shortcut"
      >
        <IconX className="h-3 w-3" />
        Esc
      </button>
    </div>
  );
}
