import { atom } from "jotai";

import { api } from "../api/client";
import type { PluginInfo, ViewerInfo } from "../api/types";
import { notesRevisionAtom } from "../state/atoms";

export type ViewerPlugin = {
  id: string;
  title: string;
  description: string;
  viewer: ViewerInfo;
};

/** Viewer plugins from `GET /api/plugins`; reload bumps the notes revision. */
export const viewerPluginsAtom = atom(async (get): Promise<ViewerPlugin[]> => {
  get(notesRevisionAtom);
  try {
    const list = await api.listPlugins();
    return list.plugins
      .filter(
        (plugin): plugin is PluginInfo & { viewer: ViewerInfo } =>
          plugin.type === "viewer" && Boolean(plugin.viewer),
      )
      .map((plugin) => ({
        id: plugin.id,
        title: plugin.title,
        description: plugin.description,
        viewer: plugin.viewer,
      }));
  } catch {
    return [];
  }
});

/** Extension (lower-case, no dot) → viewer plugin. */
export function viewerByExtension(
  plugins: ViewerPlugin[],
): Map<string, ViewerPlugin> {
  const map = new Map<string, ViewerPlugin>();
  for (const plugin of plugins) {
    for (const extension of plugin.viewer.extensions) {
      if (!map.has(extension)) map.set(extension, plugin);
    }
  }
  return map;
}

export function extensionOfPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * URL of a public viewer bundle file
 * (`/static/plugins/<domain>/<ext>/<file>`). Public on purpose: the viewer runs
 * in an opaque-origin sandbox, where module and font fetches carry no cookies.
 */
export function viewerFileUrl(pluginId: string, file: string): string {
  const [domain, extension] = pluginId.split("/");
  const encoded = file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/static/plugins/${encodeURIComponent(domain ?? pluginId)}/${encodeURIComponent(
    extension ?? "",
  )}/${encoded}`;
}

export function viewerEntryUrl(plugin: ViewerPlugin): string {
  return viewerFileUrl(plugin.id, plugin.viewer.entry);
}

/**
 * Pele theme variables derived from the app's design tokens, so a diagram in
 * the sandbox matches the host palette without inheriting host CSS.
 */
export function viewerTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    "--pele-bg": read("--color-paper", "#f8f5ec"),
    "--pele-fg": read("--color-ink", "#171a1b"),
    "--pele-muted": read("--color-muted", "#565a5b"),
    "--pele-line": read("--color-line-strong", "#a4a59d"),
    "--pele-surface": read("--color-panel", "#cfd0c9"),
    "--pele-surface-alt": read("--color-panel-strong", "#c5c6be"),
    "--pele-border": read("--color-line", "#b9bab2"),
    "--pele-accent": read("--color-accent", "#3b82f6"),
    "--pele-critical": read("--color-danger", "#dc2626"),
    "--pele-font": read("--font-sans", "sans-serif"),
    "--pele-font-mono": read("--font-mono", "monospace"),
    "--pele-radius": "4px",
  };
}
