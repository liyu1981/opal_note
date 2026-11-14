import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";

import { api } from "../api/client";
import type { AssetInfo } from "../api/types";
import {
  assetKindLabel,
  downloadAsset,
  formatBytes,
} from "../lib/assets";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { useAssetBlob } from "../lib/useAssetBlob";
import { activeNotebookIdAtom, readOnlyAtom } from "../state/atoms";
import {
  IconArrowLeft,
  IconDownload,
  IconFile,
  IconPencil,
} from "./Icons";

export function AssetDetailView({ path }: { path: string }) {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useAppNavigate();
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
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

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
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
              {!locked && (
                <button
                  type="button"
                  onClick={rename}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white hover:text-ink"
                >
                  <IconPencil className="h-3.5 w-3.5" />
                  Rename
                </button>
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
              <AssetPreview notebookId={notebookId} info={info} />
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
}: {
  notebookId: string;
  info: AssetInfo;
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
    return <ImageAssetViewer url={url} name={info.asset.name} />;
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

function ImageAssetViewer({ url, name }: { url: string; name: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);

  function zoom(next: number) {
    setScale(Math.min(6, Math.max(0.4, next)));
  }

  return (
    <div
      className="relative h-[min(70vh,44rem)] touch-none overflow-hidden rounded-lg bg-[#1b1e1f]"
      onWheel={(event) => {
        event.preventDefault();
        zoom(scale + (event.deltaY < 0 ? 0.15 : -0.15));
      }}
      onPointerDown={(event) => {
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          x: offset.x,
          y: offset.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        setOffset({
          x: drag.x + event.clientX - drag.startX,
          y: drag.y + event.clientY - drag.startY,
        });
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <div
        className="absolute inset-0 flex cursor-grab items-center justify-center active:cursor-grabbing"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
        />
      </div>
      <div
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-white/20 bg-black/40 p-1 backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoom(scale - 0.2)}
          className="rounded px-2 py-1 font-mono text-[14px] text-white transition hover:bg-white/15"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="min-w-12 text-center font-mono text-[12px] text-white/80">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoom(scale + 0.2)}
          className="rounded px-2 py-1 font-mono text-[14px] text-white transition hover:bg-white/15"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
          className="rounded px-2 py-1 font-mono text-[12px] text-white/80 transition hover:bg-white/15 hover:text-white"
        >
          Reset
        </button>
      </div>
    </div>
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
