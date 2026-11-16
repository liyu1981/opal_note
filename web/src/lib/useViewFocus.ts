import { useCallback, useEffect, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";

import {
  createViewFocusRequest,
  pendingViewFocusAtom,
  type ViewFocusTarget,
} from "../state/atoms";

/**
 * Ask the destination view to take focus after navigation. The request is
 * one-shot: the view clears it only after calling its own focus function.
 */
export function useViewFocusRequest() {
  const setPending = useSetAtom(pendingViewFocusAtom);
  return useCallback(
    (target: ViewFocusTarget, identity?: string) => {
      setPending(createViewFocusRequest(target, identity));
    },
    [setPending],
  );
}

/**
 * Consume a pending focus request once this view is ready. Views declare their
 * own target so a page can focus its editor, pages can focus the first row,
 * and so on. `"view"` is a generic fallback that matches any view.
 */
export function useViewAutoFocus(
  target: ViewFocusTarget,
  focus: () => void,
  ready = true,
  identity?: string,
) {
  const [pending, setPending] = useAtom(pendingViewFocusAtom);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!pending || !ready) return;
    if (pending.target !== target && pending.target !== "view") return;
    if (
      pending.target === target &&
      pending.identity !== undefined &&
      pending.identity !== identity
    ) {
      return;
    }
    let frame = 0;
    let second = 0;
    // Two frames let a just-mounted child (CodeMirror, a loading table, …)
    // install its DOM/ref before focus is requested.
    frame = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        try {
          focusRef.current();
        } finally {
          setPending((current) =>
            current?.id === pending.id ? null : current,
          );
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(second);
    };
  }, [identity, pending, ready, setPending, target]);
}
