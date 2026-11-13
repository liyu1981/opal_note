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
    label: "Search",
    description: "Open the global search dialog",
    group: "Navigation",
    defaultBindings: ["mod+/ f"],
  },
  {
    id: "nav.home",
    label: "Home / journal",
    description: "Open the journal feed",
    group: "Navigation",
    defaultBindings: ["mod+/ h"],
  },
  {
    id: "nav.pages",
    label: "All pages",
    description: "Open the page directory",
    group: "Navigation",
    defaultBindings: ["mod+/ a"],
  },
  {
    id: "nav.graph",
    label: "Graph",
    description: "Open the notebook graph",
    group: "Navigation",
    defaultBindings: ["mod+/ g"],
  },
  {
    id: "nav.back",
    label: "Back",
    description: "Go back in browser history",
    group: "Navigation",
    defaultBindings: ["mod+[", "alt+left"],
  },
  {
    id: "nav.forward",
    label: "Forward",
    description: "Go forward in browser history",
    group: "Navigation",
    defaultBindings: ["mod+]", "alt+right"],
  },
  {
    id: "ui.left",
    label: "Toggle left sidebar",
    description: "Show or hide the left sidebar",
    group: "Workspace",
    defaultBindings: ["mod+/ l"],
  },
  {
    id: "ui.right",
    label: "Toggle right sidebar",
    description: "Show or hide the right sidebar",
    group: "Workspace",
    defaultBindings: ["mod+/ r"],
  },
  {
    id: "command.palette",
    label: "Command palette",
    description: "Search and run workspace commands",
    group: "Workspace",
    defaultBindings: ["mod+/ p"],
  },
  {
    id: "ui.settings",
    label: "Settings",
    description: "Open the settings dialog",
    group: "Workspace",
    defaultBindings: ["mod+/ o"],
  },
  {
    id: "page.new",
    label: "New page",
    description: "Create an empty page in the current notebook",
    group: "Workspace",
    defaultBindings: ["mod+/ n"],
  },
  {
    id: "journal.today",
    label: "Today's journal",
    description: "Open or create today's journal page",
    group: "Workspace",
    defaultBindings: ["mod+/ j"],
  },
  {
    id: "editor.save",
    label: "Save page",
    description: "Save the current note immediately",
    group: "Editor",
    defaultBindings: ["mod+s", "mod+/ s"],
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
  return command.defaultBindings.map(formatBinding).join(" / ");
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
  if (event.shiftKey) parts.push("shift");
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
