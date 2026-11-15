import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { BackgroundInfo } from "../api/types";
import {
  backgroundColor,
  backgroundImageFit,
  backgroundNumber,
  backgroundString,
} from "../lib/backgroundOptions";

/** Small, static thumbnail used by Settings → Background. */
export function BackgroundPreview({
  background,
}: {
  background: BackgroundInfo;
}) {
  switch (background.kind) {
    case "dot-grid":
      return <DotGridPreview background={background} />;
    case "image":
      return <ImagePreview background={background} />;
    case "gradient":
      return <GradientPreview background={background} />;
    case "galaxy":
      return <GalaxyPreview />;
    case "grid-scan":
      return <GridScanPreview />;
    case "letter-glitch":
      return <LetterGlitchPreview />;
    case "shape-grid":
      return <ShapeGridPreview />;
    default:
      return <div className="h-full w-full bg-canvas" />;
  }
}

function DotGridPreview({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const color = backgroundColor(
    options,
    "baseColor",
    "var(--color-line-strong)",
  );
  const dotSize = backgroundNumber(options, "dotSize", 2.5, 0.5, 16);
  const gap = backgroundNumber(options, "gap", 20, 4, 64);
  const opacity = backgroundNumber(options, "opacity", 0.85, 0, 1);
  const radius = Math.max(0.6, dotSize / 2);

  return (
    <div
      className="h-full w-full"
      style={{
        backgroundColor: "var(--color-canvas)",
        backgroundImage: `radial-gradient(circle, ${color} ${radius}px, transparent ${radius + 0.5}px)`,
        backgroundSize: `${gap}px ${gap}px`,
        opacity,
      }}
    />
  );
}

function ImagePreview({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const asset = backgroundString(options, "asset");
  const fit = backgroundImageFit(options.fit);
  const opacity = backgroundNumber(options, "opacity", 1, 0, 1);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!asset) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .getBackgroundBlob(background.id, asset)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, background.id]);

  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas font-mono text-[12px] text-faint">
        {asset ? "Loading…" : "No asset"}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      className="h-full w-full"
      style={{ objectFit: fit, opacity }}
    />
  );
}

function GradientPreview({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const from = backgroundColor(options, "from", "var(--color-canvas)");
  const to = backgroundColor(options, "to", "var(--color-panel)");
  const angle = backgroundNumber(options, "angle", 135, 0, 360);

  return (
    <div
      className="h-full w-full"
      style={{ backgroundImage: `linear-gradient(${angle}deg, ${from}, ${to})` }}
    />
  );
}

function GalaxyPreview() {
  return (
    <div
      className="h-full w-full"
      style={{
        backgroundColor: "var(--color-canvas)",
        backgroundImage: [
          "radial-gradient(circle at 20% 30%, var(--color-ink-soft) 0.8px, transparent 1.4px)",
          "radial-gradient(circle at 70% 60%, var(--color-ink-soft) 1px, transparent 1.6px)",
          "radial-gradient(circle at 40% 80%, var(--color-accent-strong) 0.7px, transparent 1.3px)",
        ].join(","),
        backgroundSize: "37px 31px, 71px 67px, 53px 47px",
        opacity: 0.4,
      }}
    />
  );
}

function GridScanPreview() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-line-strong) 1px, transparent 1px), linear-gradient(90deg, var(--color-line-strong) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: 0.5,
        }}
      />
      <div className="absolute inset-y-0 left-1/2 w-px bg-accent-strong/60" />
      <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 bg-accent-strong/10 blur-sm" />
    </div>
  );
}

function LetterGlitchPreview() {
  const rows = [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "!@#$%^&*()_+-=[]{};:<>",
    "0123456789ABCDEF012345",
  ];
  return (
    <div className="flex h-full w-full flex-col justify-center gap-1 overflow-hidden bg-canvas px-1 font-mono text-[8px] leading-none tracking-[0.18em] text-ink/40">
      {rows.map((row) => (
        <span key={row} className="truncate">
          {row}
        </span>
      ))}
    </div>
  );
}

function ShapeGridPreview() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-line-strong) 1px, transparent 1px), linear-gradient(90deg, var(--color-line-strong) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: 0.55,
        }}
      />
      <div className="absolute left-[42%] top-[42%] h-6 w-6 border border-accent-strong bg-accent-strong/10 shadow-[0_0_8px_var(--color-accent-soft)]" />
    </div>
  );
}
