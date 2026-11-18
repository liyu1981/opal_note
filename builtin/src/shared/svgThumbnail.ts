/**
 * Rasterize a rendered diagram SVG into a PNG, inside the viewer frame.
 *
 * The frame is the only place with the diagram's fonts and embedded images
 * available (Excalidraw inlines its fonts into the exported SVG; diagram text
 * otherwise falls back to system faces), and an SVG loaded into an `<img>`
 * cannot reach the page's own styles or network.
 */

export type ThumbnailPng = {
  png: ArrayBuffer;
  width: number;
  height: number;
};

/** Longest edge of the generated PNG. */
const MAX_EDGE = 1400;
/**
 * Small diagrams (a four-node flowchart can be ~130 px wide) are scaled up so
 * the PNG stays readable in a card; vector art stays crisp.
 */
const MAX_UPSCALE = 3;

function svgSize(svg: Element): { width: number; height: number } {
  const parse = (value: string | null) => {
    if (!value) return 0;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  let width = parse(svg.getAttribute("width"));
  let height = parse(svg.getAttribute("height"));
  if ((!width || !height) && svg.hasAttribute("viewBox")) {
    const box = svg
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/u)
      .map((part) => Number.parseFloat(part));
    if (box && box.length === 4) {
      width = width || (box[2] ?? 0);
      height = height || (box[3] ?? 0);
    }
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

export async function svgToPng(svgText: string): Promise<ThumbnailPng | null> {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = parsed.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") return null;

  let { width, height } = svgSize(svg);
  if (width <= 0 || height <= 0) {
    width = 800;
    height = 600;
  }
  const scale = Math.max(
    0.1,
    Math.min(MAX_EDGE / Math.max(width, height), MAX_UPSCALE),
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  // Percentage or missing sizes make `<img>` rasterize at 0px; pin them.
  svg.setAttribute("width", String(targetWidth));
  svg.setAttribute("height", String(targetHeight));
  if (!svg.hasAttribute("viewBox")) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  const markup = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(
    new Blob([markup], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const image = new Image();
    image.decoding = "sync";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not rasterize the diagram"));
    });
    image.src = url;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), "image/png");
    });
    if (!blob) return null;
    return {
      png: await blob.arrayBuffer(),
      width: targetWidth,
      height: targetHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
