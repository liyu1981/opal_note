import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";

import { api } from "../api/client";
import type { AssetEntry, AssetKind, AssetList } from "../api/types";
import { assetKindLabel, downloadAsset, formatBytes } from "../lib/assets";
import { relativeTime } from "../lib/format";
import { useAppNavigate } from "../lib/appNavigation";
import { useAssetBlob } from "../lib/useAssetBlob";
import {
  activeNotebookIdAtom,
  readOnlyAtom,
} from "../state/atoms";
import {
  IconDownload,
  IconFile,
  IconFolder,
  IconPencil,
  IconRefresh,
  IconSearch,
} from "./Icons";

const PAGE_SIZE = 24;
const KINDS: Array<{ value: "" | AssetKind; label: string }> = [
  { value: "", label: "All types" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Documents" },
  { value: "other", label: "Other" },
];

export function AssetsView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useAppNavigate();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState<"" | AssetKind>("");
  const [sort, setSort] = useState("updated_at");
  const [dir, setDir] = useState("desc");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<AssetList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(0);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!notebookId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .listAssets(notebookId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        q: debouncedQuery || undefined,
        kind: kind || undefined,
        sort,
        dir,
      })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Could not load assets",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, dir, kind, notebookId, page, refresh, sort]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Select or create a notebook to browse its assets.
        </p>
      </main>
    );
  }

  function renameAsset(asset: AssetEntry) {
    if (!notebookId || locked) return;
    const name = window.prompt("Rename asset", asset.name);
    if (!name || name.trim() === asset.name) return;
    void api
      .renameAsset(notebookId, asset.path, name.trim())
      .then(() => setRefresh((value) => value + 1))
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
          <IconFolder className="h-4 w-4 text-muted" />
          <h1 className="font-serif text-[18px] font-semibold tracking-tight text-ink">
            Assets
          </h1>
          <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[14px] text-faint">
            {total}
          </span>
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={loading}
            className="ml-auto rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink disabled:opacity-40"
            aria-label="Refresh assets"
            title="Refresh assets"
          >
            <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <IconSearch className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search assets…"
              className="w-full rounded-md border border-line bg-white/60 py-1.5 pl-7 pr-2.5 font-sans text-[14px] text-ink outline-none focus:border-accent"
              aria-label="Search assets"
            />
          </label>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "" | AssetKind);
              setPage(0);
            }}
            className="rounded-md border border-line bg-white/60 px-2 py-1.5 font-mono text-[14px] text-ink-soft outline-none focus:border-accent"
            aria-label="Filter assets by type"
          >
            {KINDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(0);
            }}
            className="rounded-md border border-line bg-white/60 px-2 py-1.5 font-mono text-[14px] text-ink-soft outline-none focus:border-accent"
            aria-label="Sort assets"
          >
            <option value="updated_at">Updated</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
          <button
            type="button"
            onClick={() => setDir((value) => (value === "asc" ? "desc" : "asc"))}
            className="rounded-md border border-line bg-white/60 px-2 py-1.5 font-mono text-[14px] text-muted transition hover:bg-white hover:text-ink"
            title="Toggle sort direction"
          >
            {dir === "asc" ? "↑" : "↓"}
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
            {error}
          </p>
        )}

        {loading && !data ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                className="h-56 animate-pulse rounded-xl border border-line bg-panel/30"
              />
            ))}
          </div>
        ) : data?.assets.length === 0 ? (
          <p className="mt-10 rounded-xl border border-line bg-white/30 px-4 py-12 text-center font-sans text-[14px] text-faint">
            No assets match the current filters.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data?.assets.map((asset) => (
              <AssetCard
                key={asset.path}
                notebookId={notebookId}
                asset={asset}
                locked={locked}
                onOpen={() => navigate({ view: "asset", path: asset.path })}
                onDownload={() =>
                  void downloadAsset(notebookId, asset).catch((cause) => {
                    window.alert(
                      cause instanceof Error
                        ? cause.message
                        : "Could not download asset",
                    );
                  })
                }
                onRename={() => renameAsset(asset)}
              />
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
            <span className="font-mono text-[14px] text-faint">
              Page {page + 1} of {pageCount}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={page === 0}
                className="rounded-md border border-line px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white/60 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((value) => Math.min(pageCount - 1, value + 1))
                }
                disabled={page >= pageCount - 1}
                className="rounded-md border border-line px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:bg-white/60 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function AssetCard({
  notebookId,
  asset,
  locked,
  onOpen,
  onDownload,
  onRename,
}: {
  notebookId: string;
  asset: AssetEntry;
  locked: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onRename: () => void;
}) {
  const previewable =
    asset.kind === "image" || asset.kind === "video" || asset.kind === "audio";
  const { url, error } = useAssetBlob(notebookId, asset.path, previewable);

  return (
    <article
      className="group cursor-pointer overflow-hidden rounded-xl border border-line bg-paper transition hover:border-line-strong"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-panel/50">
        {asset.kind === "image" && url ? (
          <img
            src={url}
            alt={asset.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : asset.kind === "video" && url ? (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : asset.kind === "audio" ? (
          <IconFile className="h-10 w-10 text-faint" />
        ) : (
          <IconFile className="h-10 w-10 text-faint" />
        )}
        {error && (
          <span className="absolute inset-x-2 bottom-2 rounded bg-danger/10 px-2 py-1 font-mono text-[12px] text-danger">
            {error}
          </span>
        )}
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            className="rounded border border-line bg-white/85 p-1.5 text-muted shadow-sm transition hover:bg-white hover:text-ink"
            aria-label={`Download ${asset.name}`}
            title="Download"
          >
            <IconDownload className="h-3.5 w-3.5" />
          </button>
          {!locked && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRename();
              }}
              className="rounded border border-line bg-white/85 p-1.5 text-muted shadow-sm transition hover:bg-white hover:text-ink"
              aria-label={`Rename ${asset.name}`}
              title="Rename"
            >
              <IconPencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="border-t border-line/60 px-3 py-2.5">
        <p className="truncate font-sans text-[14px] font-medium text-ink">
          {asset.name}
        </p>
        <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
          {asset.path}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[12px] text-faint">
          <span>{assetKindLabel(asset.kind)}</span>
          <span>{formatBytes(asset.size)}</span>
          <span>{relativeTime(asset.updated_at)}</span>
        </div>
      </div>
    </article>
  );
}
