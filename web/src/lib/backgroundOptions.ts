const COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\)|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent)$/i;

export function backgroundColor(
  options: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = options[key];
  return typeof value === "string" && COLOR_PATTERN.test(value.trim())
    ? value.trim()
    : fallback;
}

export function backgroundString(
  options: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function backgroundNumber(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = options[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function backgroundBoolean(
  options: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : fallback;
}

export function backgroundImageFit(
  value: unknown,
): "cover" | "contain" | "fill" | "none" | "scale-down" {
  return value === "contain" ||
    value === "fill" ||
    value === "none" ||
    value === "scale-down"
    ? value
    : "cover";
}

export function backgroundImagePosition(value: unknown): string {
  const positions = new Set([
    "center",
    "top",
    "bottom",
    "left",
    "right",
    "top left",
    "top right",
    "bottom left",
    "bottom right",
  ]);
  return typeof value === "string" && positions.has(value) ? value : "center";
}

export function backgroundStringArray(
  options: Record<string, unknown>,
  key: string,
  fallback: string[] = [],
): string[] {
  const value = options[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && !!item);
}
