import { useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";

import {
  SHORTCUT_COMMANDS,
  chordFromEvent,
  isEditableTarget,
  resolveBindings,
} from "./shortcuts";
import { useShortcutRunner } from "./useShortcutRunner";
import { settingsAtom } from "./settings";
import {
  commandPaletteOpenAtom,
  shortcutRecordingAtom,
  shortcutSequenceAtom,
  settingsOpenAtom,
} from "../state/atoms";

const SEQUENCE_TIMEOUT_MS = 1400;

export function useKeyboardShortcuts() {
  const run = useShortcutRunner();
  const settings = useAtomValue(settingsAtom);
  const [sequence, setSequence] = useAtom(shortcutSequenceAtom);
  const recording = useAtomValue(shortcutRecordingAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const commandPaletteOpen = useAtomValue(commandPaletteOpenAtom);

  const sequenceRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const bindingsRef = useRef(new Map<string, string>());

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    if (recording || settingsOpen || commandPaletteOpen) {
      sequenceRef.current = "";
      setSequence("");
      if (timerRef.current) window.clearTimeout(timerRef.current);
    }
  }, [commandPaletteOpen, recording, setSequence, settingsOpen]);

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

    function onKeyDown(event: KeyboardEvent) {
      if (
        recording ||
        settingsOpen ||
        commandPaletteOpen ||
        event.isComposing
      ) {
        return;
      }

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
    commandPaletteOpen,
    recording,
    run,
    setSequence,
    settingsOpen,
  ]);
}
