import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { AssetInfo } from "../api/types";
import {
  assetKindLabel,
  downloadAsset,
  downloadBlob,
  formatBytes,
  isRichContentPath,
} from "../lib/assets";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { extensionOfPath } from "../plugins/viewers";
import { useViewAutoFocus } from "../lib/useViewFocus";
import { useAssetBlob } from "../lib/useAssetBlob";
import { useDiagramThumbnail } from "../lib/useDiagramThumbnail";
import { ImageZoomPane } from "./media/ImageZoomPane";
import {
  activeNotebookIdAtom,
  diagramLightboxAtom,
  readOnlyAtom,
  refreshAtom,
} from "../state/atoms";
import {
  IconArrowLeft,
  IconBook,
  IconDownload,
  IconFile,
  IconPencil,
  IconTrash,
} from "./Icons";

export function AssetDetailView({ path }: { path: string }) {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useAppNavigate();
  const refresh = useSetAtom(refreshAtom);
  const setDiagramLightbox = useSetAtom(diagramLightboxAtom);
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const diagram = useDiagramThumbnail(notebookId, info?.asset ?? null);

  useViewAutoFocus("asset", () => mainRef.current?.focus());

  useEffect(() => {
    if (!notebookId || !path) {
      setInfo(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .assetInfo(notebookId, path)
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setInfo(null);
        setError(
          cause instanceof Error ? cause.message : "Could not load asset",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, path]);

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-transparent p-8">
        <p className="font-mono text-[14px] text-muted">Select a notebook.</p>
      </main>
    );
  }

  function rename() {
    if (!notebookId || !info || locked) return;
    const name = window.prompt("Rename asset", info.asset.name);
    if (!name || name.trim() === info.asset.name) return;
    void api
      .renameAsset(notebookId, info.asset.path, name.trim())
      .then((next) => {
        navigate(
          { view: "asset", path: next.path },
          { replace: true },
        );
      })
      .catch((cause) => {
        window.alert(
          cause instanceof Error ? cause.message : "Could not rename asset",
        );
      });
  }

  function remove() {
    if (!notebookId || !info || locked) return;
    if (
      !window.confirm(
        `Move “${info.asset.name}” to the trash? It can be restored until the retention period ends.`,
      )
    ) {
      return;
    }
    void api
      .deleteAsset(notebookId, info.asset.path)
      .then(() => {
        navigate({ view: "assets" });
        refresh();
      })
      .catch((cause) => {
        window.alert(
          cause instanceof Error ? cause.message : "Could not delete asset",
        );
      });
  }

  return (
    <main
      ref={mainRef}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto bg-transparent outline-none"
    >
      <div className="mx-auto w-full max-w-7xl px-6 py-6">
        <header className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
          <button
            type="button"
            onClick={() => navigate({ view: "assets" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/50 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink"
          >
            <IconArrowLeft className="h-3.5 w-3.5" />
            Assets
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-serif text-[20px] font-semibold tracking-tight text-ink">
              {info?.asset.name ?? path.split("/").pop() ?? "Asset"}
            </h1>
            {info && (
              <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                {info.asset.path}
              </p>
            )}
          </div>
          {info && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  void downloadAsset(notebookId, info.asset).catch((cause) => {
                    window.alert(
                      cause instanceof Error
                        ? cause.message
                        : "Could not download asset",
                    );
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink"
              >
                <IconDownload className="h-3.5 w-3.5" />
                Download
              </button>
              {isRichContentPath(info.asset.path) && (
                <button
                  type="button"
                  disabled={!diagram.blob}
                  onClick={() => {
                    if (!diagram.blob) return;
                    const stem = info.asset.name.replace(/\.[^.]+$/u, "");
                    downloadBlob(`${stem}.png`, diagram.blob);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink disabled:cursor-default disabled:opacity-40"
                  title={
                    diagram.blob
                      ? "Download a PNG of the rendered diagram"
                      : "The PNG preview is still rendering"
                  }
                >
                  <IconDownload className="h-3.5 w-3.5" />
                  PNG
                </button>
              )}
              {!locked && (
                <>
                  {isRichContentPath(info.asset.path) && (
                    <button
                      type="button"
                      onClick={() =>
                        setDiagramLightbox({
                          notebookId,
                          path: info.asset.path,
                          extension: extensionOfPath(info.asset.path),
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink"
                    >
                      <IconBook className="h-3.5 w-3.5" />
                      Edit diagram
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={rename}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink"
                  >
                    <IconPencil className="h-3.5 w-3.5" />
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={remove}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </header>

        {loading ? (
          <div className="mt-6 h-80 animate-pulse rounded-xl border border-line bg-panel/30" />
        ) : error || !info ? (
          <p className="mt-6 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
            {error ?? "Asset not found."}
          </p>
        ) : (
          <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="min-w-0 rounded-xl border border-line bg-paper p-3">
              <AssetPreview
                notebookId={notebookId}
                info={info}
                diagramUrl={diagram.url}
                diagramError={diagram.error}
              />
            </section>

            <aside className="space-y-5">
              <section>
                <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
                  Details
                </h2>
                <dl className="mt-2 space-y-1.5 font-sans text-[14px]">
                  <InfoRow label="Type" value={assetKindLabel(info.asset.kind)} />
                  <InfoRow label="MIME" value={info.asset.mime} />
                  <InfoRow label="Size" value={formatBytes(info.asset.size)} />
                  <InfoRow
                    label="Updated"
                    value={relativeTime(info.asset.updated_at)}
                  />
                </dl>
              </section>

              <section>
                <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
                  Referenced in
                </h2>
                {info.references.length === 0 ? (
                  <p className="mt-2 font-sans text-[14px] leading-relaxed text-faint">
                    This asset is not referenced in any page.
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {info.references.map((reference) => (
                      <button
                        key={reference.note_path}
                        type="button"
                        onClick={() =>
                          navigate({
                            view: "note",
                            noteId: reference.note_path,
                          })
                        }
                        className="block w-full rounded-md border border-line/60 bg-white/40 px-2.5 py-2 text-left transition hover:bg-white/70"
                      >
                        <span className="block truncate font-sans text-[14px] font-medium text-ink">
                          {reference.note_path.startsWith("journals/")
                            ? formatJournalDate(reference.title)
                            : reference.title}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[12px] text-faint">
                          {reference.note_path}
                        </span>
                        <span className="mt-1 line-clamp-2 font-sans text-[14px] leading-relaxed text-muted">
                          {reference.excerpt}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}

function AssetPreview({
  notebookId,
  info,
  diagramUrl,
  diagramError,
}: {
  notebookId: string;
  info: AssetInfo;
  diagramUrl: string | null;
  diagramError: string | null;
}) {
  const previewable =
    info.asset.kind === "image" ||
    info.asset.kind === "video" ||
    info.asset.kind === "audio";
  const { url, error, loading } = useAssetBlob(
    notebookId,
    info.asset.path,
    previewable,
  );

  if (isRichContentPath(info.asset.path)) {
    if (diagramUrl) {
      return (
        <img
          src={diagramUrl}
          alt={`${info.asset.name} preview`}
          className="mx-auto max-h-[70vh] w-full rounded-lg bg-white object-contain"
        />
      );
    }
    return (
      <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-line bg-white/30 p-8 text-center font-sans text-[14px] text-muted">
        {diagramError ?? "Rendering preview…"}
      </div>
    );
  }

  if (!previewable) {
    return (
      <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line bg-white/30 p-8 text-center">
        <IconFile className="h-12 w-12 text-faint" />
        <p className="font-sans text-[14px] text-muted">
          Preview is not available for this file type.
        </p>
        <button
          type="button"
          onClick={() =>
            void downloadAsset(notebookId, info.asset).catch((cause) => {
              window.alert(
                cause instanceof Error ? cause.message : "Could not download asset",
              );
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/70 px-3 py-1.5 font-sans text-[14px] text-ink-soft transition hover:bg-white"
        >
          <IconDownload className="h-3.5 w-3.5" />
          Download file
        </button>
      </div>
    );
  }

  if (loading) {
    return <div className="h-80 animate-pulse rounded-lg bg-panel/40" />;
  }
  if (error || !url) {
    return (
      <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
        {error ?? "Could not load preview."}
      </p>
    );
  }

  if (info.asset.kind === "image") {
    return (
      <ImageZoomPane
        url={url}
        alt={info.asset.name}
        className="h-[min(70vh,44rem)] rounded-lg bg-[#1b1e1f]"
      />
    );
  }
  if (info.asset.kind === "video") {
    return (
      <video
        src={url}
        controls
        className="mx-auto max-h-[70vh] w-full rounded-lg bg-black"
      />
    );
  }
  return (
    <audio
      src={url}
      controls
      className="mx-auto my-12 w-full max-w-2xl"
    />
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 break-all text-ink-soft">{value}</dd>
    </div>
  );
}
