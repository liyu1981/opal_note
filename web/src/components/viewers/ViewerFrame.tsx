import { useEffect, useRef } from "react";

import { mountViewer, type ViewerMode } from "../../plugins/viewerMount";

/** Sandboxed viewer iframe used by the lightbox (React wrapper). */
export function ViewerFrame({
  src,
  mode,
  content,
  extension,
  theme,
  className = "",
  onResize,
  onOpen,
  onSave,
  onError,
}: {
  src: string;
  mode: ViewerMode;
  content: string;
  extension: string;
  theme?: Record<string, string>;
  className?: string;
  onResize?: (height: number) => void;
  onOpen?: () => void;
  onSave?: (content: string) => void;
  onError?: (message: string, reason: "timeout" | "viewer") => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<ReturnType<typeof mountViewer> | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Mount once per source/mode: subsequent content changes are render messages
  // so the viewer keeps its state.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mount = mountViewer(host, {
      src,
      mode,
      content: contentRef.current,
      extension,
      theme,
      onResize,
      onOpen,
      onSave,
      onError,
    });
    mountRef.current = mount;
    return () => {
      mountRef.current = null;
      mount.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, mode, extension]);

  useEffect(() => {
    mountRef.current?.render(content);
  }, [content]);

  return <div ref={hostRef} className={`h-full w-full ${className}`} />;
}
