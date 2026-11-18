import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";

import { isRichContentPath } from "./assets";
import { diagramThumbnail, type DiagramThumbnail } from "./diagramThumbnail";
import { extensionOfPath, viewerByExtension, viewerPluginsAtom, viewerEntryUrl } from "../plugins/viewers";

type AssetLike = { path: string; updated_at: string } | null;

/**
 * PNG thumbnail for a diagram asset (`.mermaid`, `.excalidraw`), rendered by
 * its viewer plugin and cached on the server. Returns empty state for
 * non-diagram assets.
 */
export function useDiagramThumbnail(
  notebookId: string | null,
  asset: AssetLike,
): DiagramThumbnail {
  const plugins = useAtomValue(viewerPluginsAtom);
  const [state, setState] = useState<DiagramThumbnail>({
    url: null,
    blob: null,
    error: null,
  });

  const path = asset?.path ?? "";
  const updatedAt = asset?.updated_at ?? "";

  useEffect(() => {
    setState({ url: null, blob: null, error: null });
    if (!notebookId || !path || !isRichContentPath(path)) return;
    const extension = extensionOfPath(path);
    const plugin = viewerByExtension(plugins).get(extension);
    if (!plugin) {
      setState({
        url: null,
        blob: null,
        error: `No viewer plugin renders .${extension}`,
      });
      return;
    }

    let cancelled = false;
    void diagramThumbnail(notebookId, path, extension, updatedAt, {
      id: plugin.id,
      src: viewerEntryUrl(plugin),
      sandbox: plugin.viewer.sandbox,
    }).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [notebookId, path, updatedAt, plugins]);

  return state;
}
