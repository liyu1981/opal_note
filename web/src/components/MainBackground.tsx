import DotGrid from "./backgrounds/DotGrid";

/**
 * Interactive dot grid scoped to the route outlet area. The left/right panels
 * and top bar sit outside this layer, so the grid never runs underneath them.
 * Colours resolve from the app theme tokens, keeping the canvas and ink palette
 * in sync with the rest of the workspace.
 */
export function MainBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-canvas"
      aria-hidden="true"
    >
      <DotGrid
        baseColor="var(--color-line-strong)"
        activeColor="var(--color-accent-strong)"
        dotSize={2.5}
        gap={20}
        proximity={150}
        strength={0.8}
        bounce={0.5}
        tension={0.35}
        returnDuration={0.9}
        shockRadius={280}
        shockStrength={3.5}
        swell={0.9}
        stretch={0.4}
        glow={0.35}
        fade={0.25}
        opacity={0.85}
        intro
        mouseInteraction
        clickShock
      />
    </div>
  );
}
