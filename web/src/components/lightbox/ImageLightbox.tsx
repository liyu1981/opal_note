import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";

import { api } from "../../api/client";
import { formatBytes } from "../../lib/assets";
import { useAppNavigate } from "../../lib/appNavigation";
import {
  imageLightboxAtom,
  type ImageLightboxTarget,
} from "../../state/atoms";
import { IconArrowUpRight } from "../Icons";
import { ImageZoomPane } from "../media/ImageZoomPane";
import { Lightbox } from "./Lightbox";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function ImageDialog({
  target,
  onClose,
}: {
  target: ImageLightboxTarget;
  onClose: () => void;
}) {
  const navigate = useAppNavigate();
  const [url, setUrl] = useState<string | null>(target.src);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);

  const load = useCallback(() => {
    if (!target.path) return;
    setError(null);
    api
      .getAssetBlob(target.notebookId, target.path)
      .then((blob) => {
        setUrl(URL.createObjectURL(blob));
        setSize(blob.size);
      })
      .catch((cause) => {
        setError(
          cause instanceof Error ? cause.message : "Could not load the image",
        );
      });
  }, [target.notebookId, target.path]);

  useEffect(() => {
    load();
  }, [load]);

  // Object URLs stay alive for the lifetime of the dialog.
  useEffect(() => {
    return () => {
      if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [url]);

  const title = target.path ? fileName(target.path) : target.alt || "Image";
  const subtitle = target.path
    ? `assets/${target.path}`
    : url
      ? new URL(url).host || "Embedded image"
      : "Image";

  return (
    <Lightbox
      label={`View ${title}`}
      title={title}
      subtitle={size ? `${subtitle} · ${formatBytes(size)}` : subtitle}
      status={error ? <span className="text-danger">Failed</span> : undefined}
      focusMode={focusMode}
      onFocusModeChange={setFocusMode}
      onClose={onClose}
      actions={
        target.path ? (
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate({ view: "asset", path: target.path ?? "" });
            }}
            aria-label="Open the asset page"
            title="Open the asset page"
            className="shrink-0 rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
          >
            <IconArrowUpRight className="h-4 w-4" />
          </button>
        ) : undefined
      }
    >
      <div className={`min-h-0 flex-1 ${focusMode ? "" : "p-2"}`}>
        {error ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
            {error}
          </p>
        ) : url ? (
          <ImageZoomPane
            url={url}
            alt={target.alt || title}
            className={`h-full w-full bg-[#1b1e1f] ${
              focusMode ? "" : "rounded-xl"
            }`}
          />
        ) : (
          <p className="px-4 py-10 text-center font-mono text-[14px] text-faint">
            Loading…
          </p>
        )}
      </div>
    </Lightbox>
  );
}

/** Enlarged, zoomable view of an image embedded in a note. */
export function ImageLightbox() {
  const [target, setTarget] = useAtom(imageLightboxAtom);

  if (!target) return null;
  return (
    <ImageDialog
      key={`${target.notebookId}:${target.path ?? target.src ?? ""}`}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}
