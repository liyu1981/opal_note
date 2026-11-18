import { useRef, useState } from "react";

/**
 * Zoomable, draggable image surface shared by the asset view and the editor
 * lightbox. Fills its parent, which supplies the height.
 */
export function ImageZoomPane({
  url,
  alt,
  className = "",
}: {
  url: string;
  alt: string;
  className?: string;
}) {
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

  function reset() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  return (
    <div
      className={`relative touch-none overflow-hidden ${className}`}
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
      onDoubleClick={reset}
    >
      <div
        className="absolute inset-0 flex cursor-grab items-center justify-center active:cursor-grabbing"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
      >
        <img
          src={url}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
        />
      </div>
      <div
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-white/20 bg-black/40 p-1 backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
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
          onClick={reset}
          className="rounded px-2 py-1 font-mono text-[12px] text-white/80 transition hover:bg-white/15 hover:text-white"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
