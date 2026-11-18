import { api } from "../api/client";
import type { AssetEntry, AssetKind } from "../api/types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadAsset(
  notebookId: string,
  asset: AssetEntry,
): Promise<void> {
  downloadBlob(asset.name, await api.getAssetBlob(notebookId, asset.path));
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
  "ico",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
  "avi",
  "mkv",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "flac",
  "aac",
  "opus",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "epub",
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  "rar",
  "log",
]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Classify an asset by its file extension, matching the server's kinds. */
export function assetKindFromPath(path: string): AssetKind {
  const extension = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "other";
}

/**
 * Markdown link target for an asset. Uploaded names are sanitized server-side,
 * so the path is usually safe as-is; names with spaces or leftover punctuation
 * use the CommonMark `<...>` destination form so the link still parses.
 */
export function assetUrl(path: string): string {
  const url = `assets/${path}`;
  return /[\s<>()]/.test(path) ? `<${url}>` : url;
}

/**
 * Extensions rendered by rich-content viewer plugins. They are embedded with
 * `![]`, not linked, so the live preview can mount their viewer.
 */
const RICH_CONTENT_EXTENSIONS = new Set(["mermaid", "mmd", "excalidraw"]);

export function isRichContentPath(path: string): boolean {
  return RICH_CONTENT_EXTENSIONS.has(extensionOf(path));
}

/** Markdown for a freshly uploaded asset: media embeds, other files link. */
export function assetMarkdown(asset: AssetEntry): string {
  const kind = assetKindFromPath(asset.path);
  const url = assetUrl(asset.path);
  return kind === "image" ||
    kind === "video" ||
    kind === "audio" ||
    isRichContentPath(asset.path)
    ? `![${asset.name}](${url})`
    : `[${asset.name}](${url})`;
}

export function assetKindLabel(kind: AssetEntry["kind"]): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "document":
      return "Document";
    default:
      return "File";
  }
}
