export type ShortcutGroup = "Navigation" | "Workspace" | "Editor";

export type ShortcutCommand = {
  id: string;
  label: string;
  description: string;
  group: ShortcutGroup;
  defaultBindings: string[];
};

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  {
    id: "nav.search",
    label: "Search / omni bar",
    description: "Focus the omni bar to search notes or tags",
    group: "Navigation",
    defaultBindings: ["mod+; f", "mod+; s"],
  },
  {
    id: "nav.home",
    label: "Home",
    description: "Open the home dashboard",
    group: "Navigation",
    defaultBindings: ["mod+; h"],
  },
  {
    id: "nav.journal",
    label: "Journals",
    description: "Open the journal feed",
    group: "Navigation",
    defaultBindings: ["mod+; j"],
  },
  {
    id: "nav.pages",
    label: "All pages",
    description: "Open the page directory",
    group: "Navigation",
    defaultBindings: ["mod+; a"],
  },
  {
    id: "nav.tasks",
    label: "Todos",
    description: "Open the todo directory with the status filter",
    group: "Navigation",
    defaultBindings: ["mod+; d"],
  },
  {
    id: "nav.graph",
    label: "Graph",
    description: "Open the notebook graph",
    group: "Navigation",
    defaultBindings: ["mod+; g"],
  },
  {
    id: "nav.assets",
    label: "Asset",
    description: "Open the asset browser",
    group: "Navigation",
    defaultBindings: [],
  },
  {
    id: "nav.trash",
    label: "Trash",
    description: "Browse and restore deleted pages, assets and notebooks",
    group: "Navigation",
    defaultBindings: ["mod+; shift+t"],
  },
  {
    id: "nav.back",
    label: "Back",
    description: "Go back in browser history",
    group: "Navigation",
    defaultBindings: ["mod+; ["],
  },
  {
    id: "nav.forward",
    label: "Forward",
    description: "Go forward in browser history",
    group: "Navigation",
    defaultBindings: ["mod+; ]"],
  },
  {
    id: "ui.left",
    label: "Toggle left sidebar",
    description: "Show or hide the left sidebar",
    group: "Workspace",
    defaultBindings: ["mod+; l"],
  },
  {
    id: "ui.right",
    label: "Toggle right sidebar",
    description: "Show or hide the right sidebar",
    group: "Workspace",
    defaultBindings: ["mod+; r"],
  },
  {
    id: "command.palette",
    label: "Command palette",
    description: "Search and run workspace commands",
    group: "Workspace",
    defaultBindings: ["mod+shift+p", "mod+; m"],
  },
  {
    id: "omni.tags",
    label: "Tag search",
    description: "Focus the omni bar to browse tags",
    group: "Workspace",
    defaultBindings: ["mod+; t"],
  },
  {
    id: "ui.settings",
    label: "Settings",
    description: "Open the settings dialog",
    group: "Workspace",
    defaultBindings: ["mod+; o"],
  },
  {
    id: "ui.help",
    label: "Keyboard help",
    description: "Open Settings on the Keyboard shortcuts tab",
    group: "Workspace",
    defaultBindings: ["mod+; ?"],
  },
  {
    id: "page.new",
    label: "New page",
    description: "Create an empty page in the current notebook",
    group: "Workspace",
    defaultBindings: ["mod+; n"],
  },
  {
    id: "journal.today",
    label: "Today's journal",
    description: "Open or create today's journal page",
    group: "Workspace",
    defaultBindings: ["mod+; shift+j"],
  },
  {
    id: "editor.save",
    label: "Save page",
    description: "Save the current note immediately",
    group: "Editor",
    defaultBindings: ["mod+s"],
  },
];

/**
 * Native CodeMirror editor bindings. These are shown in Settings but are owned
 * by the editor rather than the app command runner.
 */
export type EditorShortcut = {
  id: string;
  label: string;
  description: string;
  bindings: string[];
};

export const EDITOR_SHORTCUTS: EditorShortcut[] = [
  {
    id: "editor.native.comment",
    label: "Toggle comment",
    description: "Comment or uncomment the current markdown line",
    bindings: ["mod+/"],
  },
  {
    id: "editor.native.indent",
    label: "Indent / outdent",
    description: "Increase or decrease line indentation",
    bindings: ["tab", "shift+tab"],
  },
  {
    id: "editor.native.move-line",
    label: "Move line",
    description: "Move the current line up or down",
    bindings: ["alt+up", "alt+down"],
  },
  {
    id: "editor.native.copy-line",
    label: "Copy line",
    description: "Copy the current line up or down",
    bindings: ["shift+alt+up", "shift+alt+down"],
  },
  {
    id: "editor.native.add-cursor",
    label: "Add cursor",
    description: "Add a cursor above or below",
    bindings: ["mod+alt+up", "mod+alt+down"],
  },
  {
    id: "editor.native.undo",
    label: "Undo",
    description: "Undo the last edit",
    bindings: ["mod+z"],
  },
  {
    id: "editor.native.redo",
    label: "Redo",
    description: "Redo the last undone edit",
    bindings: ["mod+y", "mod+shift+z"],
  },
  {
    id: "editor.native.select-all",
    label: "Select all",
    description: "Select the whole note",
    bindings: ["mod+a"],
  },
  {
    id: "editor.native.blank-line",
    label: "Insert blank line",
    description: "Insert a blank line at the cursor",
    bindings: ["mod+enter"],
  },
  {
    id: "editor.native.delete-line",
    label: "Delete line",
    description: "Delete the current line",
    bindings: ["shift+mod+k"],
  },
  {
    id: "editor.native.syntax",
    label: "Move by syntax",
    description: "Move the cursor by markdown syntax",
    bindings: ["alt+left", "alt+right"],
  },
  {
    id: "editor.native.complete",
    label: "Complete",
    description: "Open the markdown/link completion menu",
    bindings: ["ctrl+space"],
  },
  {
    id: "editor.native.select-parent",
    label: "Select parent block",
    description: "Select the surrounding markdown syntax node",
    bindings: ["mod+i"],
  },
  {
    id: "editor.native.page-edge",
    label: "Previous / next page",
    description: "Move to the adjacent card at the first or last line",
    bindings: ["up", "down"],
  },
  {
    id: "editor.native.continue-markup",
    label: "Continue markup",
    description: "Continue a list, quote or other markdown block",
    bindings: ["enter"],
  },
  {
    id: "editor.native.remove-markup",
    label: "Remove markup",
    description: "Delete markdown formatting backward",
    bindings: ["backspace"],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "Navigation",
  "Workspace",
  "Editor",
];

export function resolveBindings(
  command: ShortcutCommand,
  keybindings: Record<string, string>,
): string[] {
  const custom = keybindings[command.id]?.trim();
  return custom ? [custom] : command.defaultBindings;
}

export function defaultBindingText(command: ShortcutCommand): string {
  return command.defaultBindings.length > 0
    ? command.defaultBindings.map(formatBinding).join(" / ")
    : "Unbound";
}

export function bindingLabel(
  commandId: string,
  keybindings: Record<string, string>,
): string {
  const command = SHORTCUT_COMMANDS.find((item) => item.id === commandId);
  if (!command) return "";
  return resolveBindings(command, keybindings).map(formatBinding).join(" / ");
}

export function formatBinding(binding: string): string {
  const mac = isMac();
  return binding
    .split(/\s+/u)
    .map((chord) =>
      chord
        .split("+")
        .map((part) => {
          switch (part.toLowerCase()) {
            case "mod":
              return mac ? "Cmd" : "Ctrl";
            case "meta":
              return mac ? "Cmd" : "Meta";
            case "ctrl":
              return "Ctrl";
            case "alt":
              return "Alt";
            case "shift":
              return "Shift";
            case "left":
              return "Left";
            case "right":
              return "Right";
            case "up":
              return "Up";
            case "down":
              return "Down";
            case "escape":
              return "Esc";
            case "space":
              return "Space";
            case "enter":
              return "Enter";
            case "backspace":
              return "Backspace";
            case "delete":
              return "Delete";
            case "tab":
              return "Tab";
            default:
              return part.length === 1 ? part.toUpperCase() : part;
          }
        })
        .join("+"),
    )
    .join(" ");
}

export function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/u.test(navigator.platform)
  );
}

/** Convert a keyboard event to the same normalized chord syntax used in settings. */
export function chordFromEvent(event: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
  const key = normalizeKey(event.key);
  if (!key) return null;
  const parts: string[] = [];
  const mac = isMac();
  if (mac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (mac && event.ctrlKey) parts.push("ctrl");
  if (!mac && event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  // `?` and similar shifted punctuation are recorded as the glyph itself,
  // so the documented leader chord can be written as `mod+; ?`.
  if (event.shiftKey && key !== "?") parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function normalizeKey(key: string): string | null {
  if (key === " ") return "space";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "Escape") return "escape";
  if (key === "Enter") return "enter";
  if (key === "Backspace") return "backspace";
  if (key === "Delete") return "delete";
  if (key === "Tab") return "tab";
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
