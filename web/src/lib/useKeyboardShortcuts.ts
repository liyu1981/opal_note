import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { ensureJournal } from "./journal";
import {
  SHORTCUT_COMMANDS,
  chordFromEvent,
  isEditableTarget,
  resolveBindings,
} from "./shortcuts";
import { useAppNavigate } from "./appNavigation";
import { settingsAtom } from "./settings";
import {
  activeNotebookIdAtom,
  leftPanelOpenAtom,
  readOnlyAtom,
  refreshAtom,
  rightPanelOpenAtom,
  saveRequestAtom,
  searchOpenAtom,
  settingsOpenAtom,
  shortcutRecordingAtom,
  shortcutSequenceAtom,
} from "../state/atoms";

const SEQUENCE_TIMEOUT_MS = 1400;

export function useKeyboardShortcuts() {
  const router = useRouter();
  const navigate = useAppNavigate();
  const settings = useAtomValue(settingsAtom);
  const locked = useAtomValue(readOnlyAtom);
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const [sequence, setSequence] = useAtom(shortcutSequenceAtom);
  const recording = useAtomValue(shortcutRecordingAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setLeftOpen = useSetAtom(leftPanelOpenAtom);
  const setRightOpen = useSetAtom(rightPanelOpenAtom);
  const setSaveRequest = useSetAtom(saveRequestAtom);
  const refresh = useSetAtom(refreshAtom);

  const sequenceRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const bindingsRef = useRef(new Map<string, string>());

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    if (recording || settingsOpen) {
      sequenceRef.current = "";
      setSequence("");
      if (timerRef.current) window.clearTimeout(timerRef.current);
    }
  }, [recording, setSequence, settingsOpen]);

  useEffect(() => {
    const map = new Map<string, string>();
    for (const command of SHORTCUT_COMMANDS) {
      for (const binding of resolveBindings(command, settings.keybindings)) {
        // Registry order is precedence order; surface duplicates in Settings.
        if (!map.has(binding)) map.set(binding, command.id);
      }
    }
    bindingsRef.current = map;
  }, [settings.keybindings]);

  useEffect(() => {
    function clearSequence() {
      sequenceRef.current = "";
      setSequence("");
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function run(id: string) {
      switch (id) {
        case "nav.search":
          setSearchOpen(true);
          break;
        case "nav.home":
          navigate({ view: "journal" });
          break;
        case "nav.pages":
          navigate({ view: "pages" });
          break;
        case "nav.graph":
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
          setSettingsOpen(true);
          break;
        case "page.new":
          if (notebookId && !locked) {
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
    }

    function onKeyDown(event: KeyboardEvent) {
      if (recording || settingsOpen || event.isComposing) return;

      if (event.key === "Escape" && sequenceRef.current) {
        event.preventDefault();
        clearSequence();
        return;
      }

      const chord = chordFromEvent(event);
      if (!chord) return;
      const current = sequenceRef.current
        ? `${sequenceRef.current} ${chord}`
        : chord;
      const bindings = bindingsRef.current;

      if (bindings.has(current)) {
        event.preventDefault();
        run(bindings.get(current) ?? "");
        clearSequence();
        return;
      }

      const isPrefix = [...bindings.keys()].some((binding) =>
        binding.startsWith(`${current} `),
      );
      if (isPrefix) {
        const editable = isEditableTarget(event.target);
        const sequenceStartedWithModifier = /(mod|ctrl|meta|alt)\+/u.test(
          sequenceRef.current,
        );
        if (
          editable &&
          !/(mod|ctrl|meta|alt)\+/u.test(chord) &&
          !sequenceStartedWithModifier
        ) {
          clearSequence();
          return;
        }
        event.preventDefault();
        sequenceRef.current = current;
        setSequence(current);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(clearSequence, SEQUENCE_TIMEOUT_MS);
        return;
      }

      clearSequence();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [
    locked,
    navigate,
    notebookId,
    recording,
    refresh,
    router,
    settingsOpen,
    setLeftOpen,
    setRightOpen,
    setSaveRequest,
    setSearchOpen,
    setSequence,
    setSettingsOpen,
  ]);
}
