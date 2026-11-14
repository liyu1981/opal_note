import { atom } from "jotai";

import { api } from "../api/client";
import { CODE_THEMES, DEFAULT_CODE_THEME, getCodeTheme } from "./codeThemes";

export const FONT_ROLES = [
  {
    id: "ui",
    label: "Interface",
    description: "Menus, lists, dialogs and controls",
    fallback:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  {
    id: "display",
    label: "Titles",
    description: "Page titles and display headings",
    fallback:
      '"SFMono-Regular", Menlo, Consolas, monospace',
  },
  {
    id: "editor",
    label: "Note editor",
    description: "The markdown writing surface",
    fallback:
      '"SFMono-Regular", Menlo, Consolas, monospace',
  },
  {
    id: "mono",
    label: "Labels & code",
    description: "Metadata, tags, code and technical labels",
    fallback:
      '"SFMono-Regular", Menlo, Consolas, monospace',
  },
] as const;

export type FontRole = (typeof FONT_ROLES)[number]["id"];

export type FontChoice = {
  family: string;
  google: boolean;
};

export type AppSettings = {
  fonts: Record<FontRole, FontChoice>;
  keybindings: Record<string, string>;
  codeTheme: string;
  [key: string]: unknown;
};

export const DEFAULT_SETTINGS: AppSettings = {
  fonts: {
    ui: { family: "Google Sans", google: false },
    display: { family: "JetBrains Mono", google: false },
    editor: { family: "JetBrains Mono", google: false },
    mono: { family: "JetBrains Mono", google: false },
  },
  keybindings: {},
  codeTheme: DEFAULT_CODE_THEME,
};

export const FONT_PRESETS = [
  "Google Sans",
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "DM Sans",
  "IBM Plex Sans",
  "Source Sans 3",
  "Work Sans",
  "Merriweather",
  "Playfair Display",
  "Anonymous Pro",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
];

export const settingsAtom = atom<AppSettings>(DEFAULT_SETTINGS);
export type SettingsStatus = "loading" | "saved" | "saving" | "error";
export const settingsStatusAtom = atom<SettingsStatus>("loading");
export const settingsErrorAtom = atom<string | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeSettings(value: unknown): AppSettings {
  const root = isRecord(value) ? value : {};
  const rawFonts = isRecord(root.fonts) ? root.fonts : {};
  const rawKeybindings = isRecord(root.keybindings) ? root.keybindings : {};
  const fonts = {} as Record<FontRole, FontChoice>;

  for (const role of FONT_ROLES) {
    const defaults = DEFAULT_SETTINGS.fonts[role.id];
    const rawCandidate = rawFonts[role.id];
    const candidate: Record<string, unknown> = isRecord(rawCandidate)
      ? rawCandidate
      : {};
    fonts[role.id] = {
      family:
        typeof candidate.family === "string" && candidate.family.trim()
          ? candidate.family.trim()
          : defaults.family,
      google:
        typeof candidate.google === "boolean"
          ? candidate.google
          : defaults.google,
    };
  }

  const keybindings: Record<string, string> = {};
  for (const [id, binding] of Object.entries(rawKeybindings)) {
    if (typeof binding === "string" && binding.trim()) {
      keybindings[id] = binding.trim();
    }
  }

  const codeTheme =
    typeof root.codeTheme === "string" &&
    CODE_THEMES.some((theme) => theme.id === root.codeTheme)
      ? root.codeTheme
      : DEFAULT_CODE_THEME;

  return { ...DEFAULT_SETTINGS, ...root, fonts, keybindings, codeTheme };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Remove values equal to system defaults before storing/serving settings. */
export function compactSettings(settings: AppSettings): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === "fonts" || key === "keybindings" || key === "codeTheme") continue;
    if (!same(value, DEFAULT_SETTINGS[key])) output[key] = value;
  }

  const fonts: Record<string, FontChoice> = {};
  for (const role of FONT_ROLES) {
    const value = settings.fonts[role.id];
    if (!same(value, DEFAULT_SETTINGS.fonts[role.id])) {
      fonts[role.id] = value;
    }
  }
  if (Object.keys(fonts).length > 0) output.fonts = fonts;
  if (Object.keys(settings.keybindings).length > 0) {
    output.keybindings = settings.keybindings;
  }
  if (settings.codeTheme !== DEFAULT_CODE_THEME) {
    output.codeTheme = settings.codeTheme;
  }
  return output;
}

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  for (const role of FONT_ROLES) {
    const choice = settings.fonts[role.id];
    const family = choice.family.replace(/["'\\]/gu, " ").trim();
    const fallback = role.fallback;
    const value = family ? `"${family}", ${fallback}` : fallback;
    const variable =
      role.id === "ui"
        ? "--font-sans"
        : role.id === "display"
          ? "--font-serif"
          : role.id === "editor"
            ? "--font-editor"
            : "--font-mono";
    root.style.setProperty(variable, value);
    if (choice.google && family) ensureGoogleFont(family);
  }

  // The source editor uses a fixed cell for indentation. Measure the chosen
  // editor face at 16px and keep --note-ch in sync, including after a webfont
  // finishes loading.
  const codeTheme = getCodeTheme(settings.codeTheme);
  root.style.setProperty("--code-bg", codeTheme.background);
  root.style.setProperty("--code-text", codeTheme.foreground);
  root.style.setProperty("--code-border", codeTheme.border);
  root.style.setProperty("--code-comment", codeTheme.comment);
  root.style.setProperty("--code-keyword", codeTheme.keyword);
  root.style.setProperty("--code-string", codeTheme.string);
  root.style.setProperty("--code-number", codeTheme.number);
  root.style.setProperty("--code-function", codeTheme.function);
  root.style.setProperty("--code-type", codeTheme.type);
  root.style.setProperty("--code-property", codeTheme.property);
  root.style.setProperty("--code-operator", codeTheme.operator);
  root.style.setProperty("--code-tag", codeTheme.tag);
  root.style.setProperty("--code-meta", codeTheme.meta);
  root.style.setProperty("--code-invalid", codeTheme.invalid);

  const editor = settings.fonts.editor;
  const measureNoteCh = () => {
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) return;
    canvas.font = `16px "${editor.family.replace(/["'\\]/gu, " ")}", monospace`;
    const width = canvas.measureText("0").width;
    if (width > 0) {
      root.style.setProperty("--note-ch", `${(width / 16).toFixed(4)}rem`);
    }
  };
  measureNoteCh();
  void document.fonts?.ready.then(measureNoteCh).catch(() => {});
  window.setTimeout(measureNoteCh, 350);
}

function ensureGoogleFont(family: string): void {
  const id = `google-font-${family.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  // Ask only for the family's native faces. Browsers synthesize weights for
  // fonts that do not publish every Square weight, which keeps arbitrary
  // Google Fonts usable.
  const encoded = encodeURIComponent(family.trim()).replace(/%20/gu, "+");
  link.href = `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;
  document.head.appendChild(link);
}

const DB_NAME = "opalnote-settings";
const DB_STORE = "cache";
const DB_KEY = "settings";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readCachedSettings(): Promise<unknown | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db
      .transaction(DB_STORE, "readonly")
      .objectStore(DB_STORE)
      .get(DB_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

async function writeCachedSettings(value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const request = db
      .transaction(DB_STORE, "readwrite")
      .objectStore(DB_STORE)
      .put(value, DB_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

/**
 * Load cached settings immediately, then revalidate from the server. The
 * server copy always wins on page load; the IndexedDB copy only removes the
 * initial flash and keeps the UI usable if the server is briefly unavailable.
 */
export async function bootstrapSettings(): Promise<{
  settings: AppSettings;
  warning?: string;
}> {
  let cached: unknown = null;
  try {
    cached = await readCachedSettings();
  } catch {
    // IndexedDB is optional.
  }
  const cachedSettings = mergeSettings(cached);
  applySettings(cachedSettings);

  try {
    const remote = await api.getSettings();
    const merged = mergeSettings(remote);
    applySettings(merged);
    void writeCachedSettings(compactSettings(merged));
    return { settings: merged };
  } catch (cause) {
    return {
      settings: cachedSettings,
      warning:
        cause instanceof Error
          ? cause.message
          : "Could not refresh settings from the server",
    };
  }
}

/** Persist sparse user overrides to the server and the local cache. */
export async function persistSettings(settings: AppSettings): Promise<void> {
  const sparse = compactSettings(settings);
  applySettings(settings);
  await writeCachedSettings(sparse);
  await api.saveSettings(sparse);
}
