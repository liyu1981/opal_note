import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import { ApiError, api } from "../../api/client";
import type { AssetInfo } from "../../api/types";
import { formatBytes } from "../../lib/assets";
import {
  viewerByExtension,
  viewerEntryUrl,
  viewerPluginsAtom,
  viewerTheme,
} from "../../plugins/viewers";
import {
  assetRevisionAtom,
  diagramEditorOpenAtom,
  diagramLightboxAtom,
  readOnlyAtom,
} from "../../state/atoms";
import { ViewerFrame } from "../viewers/ViewerFrame";
import { IconChevron, IconMaximize, IconMinimize, IconX } from "../Icons";
import { SourceEditor } from "./SourceEditor";

type Status = "loading" | "saved" | "dirty" | "saving" | "error";

function DiagramDialog({
  notebookId,
  path,
  extension,
  onClose,
  onSaved,
}: {
  notebookId: string;
  path: string;
  extension: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const plugins = useAtomValue(viewerPluginsAtom);
  const viewer = useMemo(
    () => viewerByExtension(plugins).get(extension) ?? null,
    [extension, plugins],
  );
  const [editorOpen, setEditorOpen] = useAtom(diagramEditorOpenAtom);
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [saved, setSaved] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);

  const dirty = status !== "loading" && content !== saved;

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [assetInfo, blob] = await Promise.all([
        api.assetInfo(notebookId, path),
        api.getAssetBlob(notebookId, path),
      ]);
      const text = await blob.text();
      setInfo(assetInfo);
      setSaved(text);
      setContent(text);
      setPreview(text);
      setStatus("saved");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load the asset",
      );
      setStatus("error");
    }
  }, [notebookId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced preview updates: Pele re-renders in well under a millisecond.
  useEffect(() => {
    if (status === "loading" || status === "error") return;
    const timer = window.setTimeout(() => setPreview(content), 150);
    return () => window.clearTimeout(timer);
  }, [content, status]);

  const save = useCallback(async () => {
    if (!info || status === "saving" || content === saved) return;
    setStatus("saving");
    setError(null);
    try {
      const entry = await api.updateAssetContent(notebookId, path, {
        content,
        base_updated_at: info.asset.updated_at,
      });
      setInfo((current) =>
        current ? { ...current, asset: entry } : current,
      );
      setSaved(content);
      setStatus("saved");
      onSaved();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError("This file changed elsewhere. Reload before saving again.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not save");
      }
      setStatus("error");
    }
  }, [content, info, notebookId, onSaved, path, saved, status]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        event.preventDefault();
        if (focusMode) {
          setFocusMode(false);
          return;
        }
        requestClose();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFocusMode((current) => !current);
        return;
      }
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (mod && event.key === "\\") {
        event.preventDefault();
        setEditorOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode, requestClose, save, setEditorOpen]);

  const statusLabel =
    status === "loading"
      ? "Loading…"
      : status === "saving"
        ? "Saving…"
        : status === "error"
          ? "Save failed"
          : dirty
            ? "Unsaved"
            : "Saved";

  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 backdrop-blur-sm ${
        focusMode ? "p-0" : "p-2 sm:p-4"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${info?.asset.name ?? path}`}
    >
      <div
        className={`flex flex-col overflow-hidden border-line bg-canvas shadow-panel ${
          focusMode
            ? "h-full w-full border-0"
            : "h-[min(64rem,96vh)] w-[min(94rem,98vw)] rounded-2xl border"
        }`}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-[18px] font-semibold text-ink">
              {info?.asset.name ?? path.split("/").pop()}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
              {path}
              {info ? ` · ${formatBytes(info.asset.size)}` : ""}
            </p>
          </div>
          <span
            className={`shrink-0 font-mono text-[14px] ${
              status === "error" ? "text-danger" : "text-faint"
            }`}
          >
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={() => setFocusMode((current) => !current)}
            aria-pressed={focusMode}
            aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
            title={`${focusMode ? "Exit focus mode" : "Focus mode"} (Cmd/Ctrl+Shift+F)`}
            className="shrink-0 rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
          >
            {focusMode ? (
              <IconMinimize className="h-4 w-4" />
            ) : (
              <IconMaximize className="h-4 w-4" />
            )}
          </button>
          {viewer?.viewer.role === "renderer" && (
            <button
              type="button"
              onClick={() => setEditorOpen((open) => !open)}
              aria-expanded={editorOpen}
              aria-label={editorOpen ? "Hide source" : "Show source"}
              title={`${editorOpen ? "Hide source" : "Show source"} (Cmd/Ctrl+\\)`}
              className="shrink-0 rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
            >
              <IconChevron
                className={`h-4 w-4 transition ${editorOpen ? "rotate-90" : "-rotate-90"}`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || status === "saving" || !info}
            className="shrink-0 rounded-md border border-transparent px-2.5 py-1 font-sans text-[14px] font-medium text-accent-strong transition hover:border-line hover:bg-white/60 disabled:cursor-default disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        {error && (
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-danger/10 px-4 py-2 font-mono text-[14px] text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="shrink-0 rounded-md border border-danger/40 px-2 py-0.5 text-danger transition hover:bg-danger/10"
            >
              Reload
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {editorOpen && viewer?.viewer.role === "renderer" && (
            <div
              className={`flex shrink-0 flex-col border-r border-line ${
                focusMode ? "w-[34%] min-w-[18rem]" : "w-[42%] min-w-[16rem]"
              }`}
            >
              <SourceEditor value={content} onChange={setContent} />
            </div>
          )}
          <div className="min-w-0 flex-1 p-2">
            {viewer ? (
              <div className="h-full w-full overflow-hidden rounded-xl border border-line bg-paper">
                <ViewerFrame
                  src={viewerEntryUrl(viewer)}
                  mode="edit"
                  content={preview}
                  extension={extension}
                  theme={viewerTheme()}
                  onSave={setContent}
                  onError={(message) => setError(message)}
                />
              </div>
            ) : (
              <p className="px-4 py-10 text-center font-mono text-[14px] text-faint">
                No viewer plugin handles “{extension}”.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** App-level lightbox for viewer-backed assets (Mermaid source + preview). */
export function DiagramLightbox() {
  const [target, setTarget] = useAtom(diagramLightboxAtom);
  const locked = useAtomValue(readOnlyAtom);
  const refreshAssets = useSetAtom(assetRevisionAtom);
  const bumpAssets = useCallback(
    () => refreshAssets((revision) => revision + 1),
    [refreshAssets],
  );

  if (!target || locked) return null;
  return (
    <DiagramDialog
      key={`${target.notebookId}:${target.path}`}
      notebookId={target.notebookId}
      path={target.path}
      extension={target.extension}
      onClose={() => setTarget(null)}
      onSaved={bumpAssets}
    />
  );
}
