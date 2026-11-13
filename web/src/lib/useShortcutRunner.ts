import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { ensureJournal } from "./journal";
import { useAppNavigate } from "./appNavigation";
import {
  activeNotebookIdAtom,
  commandPaletteOpenAtom,
  leftPanelOpenAtom,
  readOnlyAtom,
  refreshAtom,
  rightPanelOpenAtom,
  saveRequestAtom,
  searchOpenAtom,
  settingsOpenAtom,
} from "../state/atoms";

/**
 * Single implementation of every command action. The keyboard dispatcher and
 * the command palette both call this so they can never drift apart.
 */
export function useShortcutRunner() {
  const router = useRouter();
  const navigate = useAppNavigate();
  const locked = useAtomValue(readOnlyAtom);
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);
  const setLeftOpen = useSetAtom(leftPanelOpenAtom);
  const setRightOpen = useSetAtom(rightPanelOpenAtom);
  const setSaveRequest = useSetAtom(saveRequestAtom);
  const refresh = useSetAtom(refreshAtom);

  return useCallback(
    (id: string) => {
      switch (id) {
        case "nav.search":
          setCommandPaletteOpen(false);
          setSearchOpen(true);
          break;
        case "command.palette":
          setSearchOpen(false);
          setCommandPaletteOpen(true);
          break;
        case "nav.home":
          setSearchOpen(false);
          setCommandPaletteOpen(false);
          navigate({ view: "journal" });
          break;
        case "nav.pages":
          setSearchOpen(false);
          setCommandPaletteOpen(false);
          navigate({ view: "pages" });
          break;
        case "nav.graph":
          setSearchOpen(false);
          setCommandPaletteOpen(false);
          navigate({ view: "graph" });
          break;
        case "nav.back":
          router.history.back();
          break;
        case "nav.forward":
          router.history.forward();
          break;
        case "ui.left":
          setLeftOpen((open) => !open);
          break;
        case "ui.right":
          setRightOpen((open) => !open);
          break;
        case "ui.settings":
          setSearchOpen(false);
          setCommandPaletteOpen(false);
          setSettingsOpen(true);
          break;
        case "page.new":
          if (notebookId && !locked) {
            setSearchOpen(false);
            setCommandPaletteOpen(false);
            void api
              .createNote(notebookId, { title: "Untitled", content: "" })
              .then((note) => {
                navigate({ view: "note", noteId: note.id });
                refresh();
              })
              .catch((cause) => {
                window.alert(
                  cause instanceof Error
                    ? cause.message
                    : "Could not create page",
                );
              });
          }
          break;
        case "journal.today":
          if (notebookId && !locked) {
            setSearchOpen(false);
            setCommandPaletteOpen(false);
            void ensureJournal(notebookId)
              .then((note) => {
                navigate({ view: "note", noteId: note.id });
                refresh();
              })
              .catch((cause) => {
                window.alert(
                  cause instanceof Error
                    ? cause.message
                    : "Could not open today's journal",
                );
              });
          }
          break;
        case "editor.save":
          setSaveRequest((request) => request + 1);
          break;
      }
    },
    [
      locked,
      navigate,
      notebookId,
      refresh,
      router,
      setCommandPaletteOpen,
      setLeftOpen,
      setRightOpen,
      setSaveRequest,
      setSearchOpen,
      setSettingsOpen,
    ],
  );
}
