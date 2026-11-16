import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { ensureJournal } from "./journal";
import { useAppNavigate } from "./appNavigation";
import { useViewFocusRequest } from "./useViewFocus";
import {
  activeNotebookIdAtom,
  leftPanelOpenAtom,
  omniFocusRequestAtom,
  omniQueryAtom,
  readOnlyAtom,
  refreshAtom,
  rightPanelOpenAtom,
  saveRequestAtom,
  settingsOpenAtom,
  settingsTabAtom,
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
  const setOmniFocus = useSetAtom(omniFocusRequestAtom);
  const setOmniQuery = useSetAtom(omniQueryAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSettingsTab = useSetAtom(settingsTabAtom);
  const setLeftOpen = useSetAtom(leftPanelOpenAtom);
  const setRightOpen = useSetAtom(rightPanelOpenAtom);
  const setSaveRequest = useSetAtom(saveRequestAtom);
  const refresh = useSetAtom(refreshAtom);
  const requestViewFocus = useViewFocusRequest();

  return useCallback(
    (id: string) => {
      switch (id) {
        case "nav.search":
          setOmniFocus((request) => request + 1);
          break;
        case "command.palette":
          setOmniQuery(">");
          setOmniFocus((request) => request + 1);
          break;
        case "nav.home":
          requestViewFocus("home");
          navigate({ view: "home" });
          break;
        case "nav.journal":
          requestViewFocus("journal");
          navigate({ view: "journal" });
          break;
        case "nav.pages":
          requestViewFocus("pages");
          navigate({ view: "pages" });
          break;
        case "nav.graph":
          requestViewFocus("graph");
          navigate({ view: "graph" });
          break;
        case "nav.assets":
          requestViewFocus("assets");
          navigate({ view: "assets" });
          break;
        case "nav.trash":
          requestViewFocus("trash");
          navigate({ view: "trash" });
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
          setSettingsOpen(true);
          break;
        case "ui.help":
          setSettingsTab("shortcuts");
          setSettingsOpen(true);
          break;
        case "page.new":
          if (notebookId && !locked) {
            void api
              .createNote(notebookId, { title: "Untitled", content: "" })
              .then((note) => {
                requestViewFocus("note", note.id);
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
            void ensureJournal(notebookId)
              .then((note) => {
                requestViewFocus("note", note.id);
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
      requestViewFocus,
      router,
      setLeftOpen,
      setRightOpen,
      setSaveRequest,
      setSettingsOpen,
      setSettingsTab,
      setOmniFocus,
      setOmniQuery,
    ],
  );
}
