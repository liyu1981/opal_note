import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";

import { api } from "../api/client";
import type { BackgroundInfo } from "../api/types";
import {
  backgroundBoolean,
  backgroundColor,
  backgroundImageFit,
  backgroundImagePosition,
  backgroundNumber,
  backgroundString,
  backgroundStringArray,
} from "../lib/backgroundOptions";
import { DEFAULT_BACKGROUND_ID, settingsAtom } from "../lib/settings";
import { backgroundsAtom, backgroundsRevisionAtom } from "../state/atoms";
import DotGrid from "./backgrounds/DotGrid";
import Galaxy from "./backgrounds/Galaxy";
import GridScan from "./backgrounds/GridScan";
import LetterGlitch from "./backgrounds/LetterGlitch";
import ShapeGrid from "./backgrounds/ShapeGrid";

/**
 * Interactive background scoped to the route outlet area. The left/right
 * panels and top bar sit outside this layer, so backgrounds never run
 * underneath them. Built-in and user backgrounds are declared on the server;
 * this component is the client renderer registry for the supported kinds.
 */
export function MainBackground() {
  const list = useAtomValue(backgroundsAtom);
  const revision = useAtomValue(backgroundsRevisionAtom);
  const settings = useAtomValue(settingsAtom);
  const selected =
    list.backgrounds.find((background) => background.id === settings.backgroundId) ??
    list.backgrounds.find((background) => background.id === DEFAULT_BACKGROUND_ID) ??
    list.backgrounds[0];

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-canvas"
      aria-hidden="true"
    >
      {selected && (
        <BackgroundLayer
          key={`${selected.id}:${revision}`}
          background={selected}
        />
      )}
    </div>
  );
}

function BackgroundLayer({ background }: { background: BackgroundInfo }) {
  switch (background.kind) {
    case "dot-grid":
      return <DotGridBackground background={background} />;
    case "image":
      return <ImageBackground background={background} />;
    case "gradient":
      return <GradientBackground background={background} />;
    case "galaxy":
      return <GalaxyBackground background={background} />;
    case "grid-scan":
      return <GridScanBackground background={background} />;
    case "letter-glitch":
      return <LetterGlitchBackground background={background} />;
    case "shape-grid":
      return <ShapeGridBackground background={background} />;
    default:
      return null;
  }
}

function DotGridBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const baseColor = backgroundColor(options, "baseColor", "var(--color-line-strong)");
  const activeColor = backgroundColor(
    options,
    "activeColor",
    "var(--color-accent-strong)",
  );

  return (
    <DotGrid
      baseColor={baseColor}
      activeColor={activeColor}
      dotSize={backgroundNumber(options, "dotSize", 2.5, 0.5, 16)}
      gap={backgroundNumber(options, "gap", 20, 4, 64)}
      proximity={backgroundNumber(options, "proximity", 150, 40, 400)}
      strength={backgroundNumber(options, "strength", 0.8, 0, 3)}
      bounce={backgroundNumber(options, "bounce", 0.5, 0, 1)}
      tension={backgroundNumber(options, "tension", 0.35, 0, 1)}
      returnDuration={backgroundNumber(options, "returnDuration", 0.9, 0.1, 5)}
      shockRadius={backgroundNumber(options, "shockRadius", 280, 40, 800)}
      shockStrength={backgroundNumber(options, "shockStrength", 3.5, 0, 12)}
      swell={backgroundNumber(options, "swell", 0.9, 0, 2)}
      stretch={backgroundNumber(options, "stretch", 0.4, 0, 3)}
      glow={backgroundNumber(options, "glow", 0.35, 0, 2)}
      fade={backgroundNumber(options, "fade", 0.25, 0, 1)}
      opacity={backgroundNumber(options, "opacity", 0.85, 0, 1)}
      shape={options.shape === "square" ? "square" : "circle"}
      intro={backgroundBoolean(options, "intro", true)}
      mouseInteraction={backgroundBoolean(options, "mouseInteraction", true)}
      clickShock={backgroundBoolean(options, "clickShock", true)}
    />
  );
}

function ImageBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const asset = backgroundString(options, "asset", "");
  const fit = backgroundImageFit(options.fit);
  const position = backgroundImagePosition(options.position);
  const opacity = backgroundNumber(options, "opacity", 1, 0, 1);
  const blur = backgroundNumber(options, "blur", 0, 0, 40);
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

  if (!url) return null;

  return (
    <img
      src={url}
      alt=""
      className="absolute inset-0 h-full w-full"
      style={{
        objectFit: fit,
        objectPosition: position,
        opacity,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
      }}
    />
  );
}

function GalaxyBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  return (
    <Galaxy
      className="h-full w-full"
      lightMode={backgroundBoolean(options, "lightMode", true)}
      transparent={backgroundBoolean(options, "transparent", true)}
      starColors={backgroundStringArray(options, "starColors")}
      backgroundColor={backgroundColor(
        options,
        "backgroundColor",
        "var(--color-canvas)",
      )}
      density={backgroundNumber(options, "density", 0.7, 0.01, 5)}
      glowIntensity={backgroundNumber(options, "glowIntensity", 0.18, 0, 3)}
      starSize={backgroundNumber(options, "starSize", 1, 0, 8)}
      flareIntensity={backgroundNumber(options, "flareIntensity", 0.5, 0, 8)}
      twinkleIntensity={backgroundNumber(options, "twinkleIntensity", 0.25, 0, 1)}
      starSpeed={backgroundNumber(options, "starSpeed", 0.15, 0, 10)}
      speed={backgroundNumber(options, "speed", 0.5, 0, 10)}
      rotationSpeed={backgroundNumber(options, "rotationSpeed", 0.03, 0, 5)}
      layers={Math.round(backgroundNumber(options, "layers", 3, 2, 8))}
      direction={options.direction === "backward" ? "backward" : "forward"}
      mouseInteraction={backgroundBoolean(options, "mouseInteraction", true)}
      mouseRepulsion={backgroundBoolean(options, "mouseRepulsion", true)}
      repulsionStrength={backgroundNumber(options, "repulsionStrength", 0.8, 0, 10)}
      autoCenterRepulsion={backgroundNumber(options, "autoCenterRepulsion", 0, 0, 10)}
      clickWarp={backgroundBoolean(options, "clickWarp", true)}
      intro={backgroundBoolean(options, "intro", true)}
      opacity={backgroundNumber(options, "opacity", 0.55, 0, 1)}
    />
  );
}

function GridScanBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  return (
    <GridScan
      className="h-full w-full"
      lightMode={backgroundBoolean(options, "lightMode", true)}
      linesColor={backgroundColor(options, "linesColor", "var(--color-line-strong)")}
      scanColor={backgroundColor(options, "scanColor", "var(--color-accent-strong)")}
      cells={backgroundNumber(options, "cells", 8, 2, 40)}
      lineThickness={backgroundNumber(options, "lineThickness", 1, 0.5, 4)}
      lineStyle={gridLineStyle(options.lineStyle)}
      depth={backgroundNumber(options, "depth", 3, 0.5, 12)}
      depthFade={backgroundNumber(options, "depthFade", 0.5, 0, 1)}
      parallax={backgroundNumber(options, "parallax", 0.5, 0, 2)}
      shading={backgroundNumber(options, "shading", 0.35, 0, 1)}
      reflection={backgroundNumber(options, "reflection", 0.2, 0, 1)}
      points={backgroundBoolean(options, "points", true)}
      scanDirection={gridScanDirection(options.scanDirection)}
      scanDuration={backgroundNumber(options, "scanDuration", 3.2, 0.2, 20)}
      scanDelay={backgroundNumber(options, "scanDelay", 2.5, 0, 20)}
      scanWidth={backgroundNumber(options, "scanWidth", 1, 0.2, 5)}
      trail={backgroundNumber(options, "trail", 0.4, 0, 1)}
      glow={backgroundNumber(options, "glow", 0.25, 0, 1)}
      autoScan={backgroundBoolean(options, "autoScan", true)}
      interactive={backgroundBoolean(options, "interactive", true)}
      clickEffect={gridScanClickEffect(options.clickEffect)}
      enableWebcam={false}
      showPreview={false}
      intro={backgroundBoolean(options, "intro", true)}
    />
  );
}

function LetterGlitchBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  return (
    <LetterGlitch
      className="h-full w-full"
      lightMode={backgroundBoolean(options, "lightMode", true)}
      glitchColors={backgroundStringArray(options, "glitchColors", [
        "var(--color-ink)",
        "var(--color-accent-strong)",
      ])}
      baseColor={backgroundColor(options, "baseColor", "var(--color-ink)")}
      characters={backgroundString(options, "characters", undefined)}
      fontFamily={backgroundString(options, "fontFamily", undefined)}
      fontSize={backgroundNumber(options, "fontSize", 14, 6, 96)}
      spacing={backgroundNumber(options, "spacing", 0.6, 0, 2)}
      density={backgroundNumber(options, "density", 0.45, 0, 1)}
      baseOpacity={backgroundNumber(options, "baseOpacity", 0.12, 0, 1)}
      glitchAmount={backgroundNumber(options, "glitchAmount", 0.35, 0, 1)}
      speed={backgroundNumber(options, "speed", 0.8, 0, 5)}
      flow={backgroundNumber(options, "flow", 0.3, 0, 2)}
      smooth={backgroundBoolean(options, "smooth", true)}
      interactive={backgroundBoolean(options, "interactive", true)}
      cursorRadius={backgroundNumber(options, "cursorRadius", 120, 0, 600)}
      clickEffect={letterGlitchClickEffect(options.clickEffect)}
      edgeFade={backgroundNumber(options, "edgeFade", 0.35, 0, 1)}
      centerFade={backgroundNumber(options, "centerFade", 0.2, 0, 1)}
      intro={backgroundBoolean(options, "intro", true)}
    />
  );
}

function ShapeGridBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  return (
    <ShapeGrid
      className="h-full w-full"
      shape={shapeGridShape(options.shape)}
      cellSize={backgroundNumber(options, "cellSize", 40, 8, 120)}
      lineWidth={backgroundNumber(options, "lineWidth", 1, 0.25, 6)}
      direction={shapeGridDirection(options.direction)}
      speed={backgroundNumber(options, "speed", 0.2, 0, 3)}
      lineColor={backgroundColor(options, "lineColor", "var(--color-line-strong)")}
      hoverColor={backgroundColor(options, "hoverColor", "var(--color-accent-strong)")}
      hoverFillColor={backgroundColor(
        options,
        "hoverFillColor",
        "var(--color-accent-strong)",
      )}
      fillOpacity={backgroundNumber(options, "fillOpacity", 0.12, 0, 1)}
      rainbow={backgroundBoolean(options, "rainbow", false)}
      tiltX={backgroundNumber(options, "tiltX", 0, -70, 70)}
      tiltY={backgroundNumber(options, "tiltY", 0, -70, 70)}
      radius={backgroundNumber(options, "radius", 1.5, 0, 6)}
      trail={backgroundNumber(options, "trail", 0.5, 0.05, 3)}
      glow={backgroundNumber(options, "glow", 0.2, 0, 1)}
      twinkle={backgroundNumber(options, "twinkle", 0.05, 0, 1)}
      fade={backgroundNumber(options, "fade", 0.35, 0, 1)}
      clickCascade={backgroundBoolean(options, "clickCascade", true)}
      intro={backgroundBoolean(options, "intro", true)}
      opacity={backgroundNumber(options, "opacity", 0.55, 0, 1)}
    />
  );
}

function GradientBackground({ background }: { background: BackgroundInfo }) {
  const options = background.options;
  const from = backgroundColor(options, "from", "var(--color-canvas)");
  const to = backgroundColor(options, "to", "var(--color-panel)");
  const angle = backgroundNumber(options, "angle", 135, 0, 360);

  return (
    <div
      className="absolute inset-0"
      style={{ backgroundImage: `linear-gradient(${angle}deg, ${from}, ${to})` }}
    />
  );
}

function gridLineStyle(value: unknown): "solid" | "dashed" | "dotted" {
  return value === "dashed" || value === "dotted" ? value : "solid";
}

function gridScanDirection(
  value: unknown,
): "forward" | "backward" | "pingpong" {
  return value === "backward" || value === "pingpong" ? value : "forward";
}

function gridScanClickEffect(value: unknown): "ping" | "scan" | "none" {
  return value === "scan" || value === "none" ? value : "ping";
}

function letterGlitchClickEffect(value: unknown): "tear" | "burst" | "none" {
  return value === "burst" || value === "none" ? value : "tear";
}

function shapeGridShape(
  value: unknown,
):
  | "square"
  | "tile"
  | "hexagon"
  | "triangle"
  | "diamond"
  | "circle"
  | "cross"
  | "dot" {
  return value === "tile" ||
    value === "hexagon" ||
    value === "triangle" ||
    value === "diamond" ||
    value === "circle" ||
    value === "cross" ||
    value === "dot"
    ? value
    : "square";
}

function shapeGridDirection(
  value: unknown,
): "diagonal" | "up" | "down" | "left" | "right" | "none" {
  return value === "up" ||
    value === "down" ||
    value === "left" ||
    value === "right" ||
    value === "none"
    ? value
    : "diagonal";
}
