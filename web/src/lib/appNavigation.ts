import { useNavigate } from "@tanstack/react-router";

export type AppTarget =
  | { view: "journal" }
  | { view: "pages" }
  | { view: "graph" }
  | { view: "note"; noteId: string };

/**
 * Map app-level destinations to TanStack Router paths/search. Keeping this in
 * one hook prevents view components from inventing their own URL shapes.
 */
export function useAppNavigate() {
  const navigate = useNavigate();

  return (target: AppTarget, options?: { replace?: boolean }) => {
    const replace = options?.replace;
    switch (target.view) {
      case "journal":
        void navigate({ to: "/journal", replace });
        break;
      case "pages":
        void navigate({ to: "/pages", replace });
        break;
      case "graph":
        void navigate({ to: "/graph", replace });
        break;
      case "note":
        void navigate({
          to: "/page",
          search: { p: target.noteId },
          replace,
        });
        break;
    }
  };
}
