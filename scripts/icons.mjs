#!/usr/bin/env node
// Rasterize the PWA icons from their SVG sources.
//
// The app icons are **full-bleed**: the paper background reaches every edge, with
// no inset and no border, so iOS/Android masking cannot produce a visible frame
// or gap. `icon.svg` rounds its own corners for platforms that show the image
// as-is; `icon-maskable.svg` is an opaque square because maskable and Apple icons
// are always cropped by the platform.
//
// Usage: pnpm icons   (needs Chromium; the rounded icons keep transparent
// corners, the square ones are fully opaque)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS = path.join(ROOT, "web/public/icons");

/** [svg source, output file, pixel size] */
const TARGETS = [
  // Rounded corners for platforms that show the image as-is.
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  // Opaque squares: maskable (66% safe zone) and Apple touch (78%, iOS masks it).
  ["icon-maskable.svg", "icon-512-maskable.png", 512],
  ["icon-square.svg", "apple-touch-icon.png", 180],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

for (const [source] of TARGETS) {
  const file = path.join(ICONS, source);
  if (!fs.existsSync(file)) fail(`missing ${path.relative(ROOT, file)}`);
}

const port = 9410 + Math.floor(Math.random() * 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opalnote-icons-"));
const chrome = spawn(
  "chromium-browser",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=600,600",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const session = await connectWithRetry();

try {
  for (const [source, output, size] of TARGETS) {
    const svg = fs.readFileSync(path.join(ICONS, source), "utf8").replace(
      /<svg /,
      `<svg width="${size}" height="${size}" `,
    );
    const html =
      "<html><head><style>html,body{margin:0;background:transparent}</style>" +
      `</head><body>${svg}</body></html>`;
    await session.command("Emulation.setDeviceMetricsOverride", {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.command("Page.navigate", {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    });
    await sleep(300);
    const shot = await session.command("Page.captureScreenshot", {
      format: "png",
      omitBackground: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    });
    const data = shot.result?.data;
    if (!data) fail(`could not screenshot ${output}`);
    fs.writeFileSync(path.join(ICONS, output), Buffer.from(data, "base64"));
    console.log(
      `  wrote ${path.relative(ROOT, path.join(ICONS, output))} (${size}×${size})`,
    );
  }
} finally {
  session.close();
  chrome.kill("SIGKILL");
  fs.rmSync(profile, { recursive: true, force: true });
}

/** Connect to the page target, retrying while Chromium boots. */
async function connectWithRetry() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let target = null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await response.json()).find((entry) => entry.type === "page");
      target = page?.webSocketDebuggerUrl ?? null;
    } catch {
      // Chromium has not opened the DevTools port yet.
    }
    if (target) return connect(target);
    await sleep(250);
  }
  chrome.kill("SIGKILL");
  fail("Chromium's DevTools endpoint did not start.");
}

/** Minimal DevTools client: one page target, request/response only. */
function connect(target) {
  const { hostname, port: wsPort, pathname } = new URL(target);
  const socket = net.connect(Number(wsPort), hostname);
  const pending = new Map();
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let upgraded = false;

  const send = (text) => {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, mask, masked]));
  };

  const command = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      send(JSON.stringify({ id, method, params }));
    });

  return new Promise((resolve, reject) => {
    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${wsPort}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!buffer.subarray(0, end).toString().includes("101")) {
          reject(new Error("DevTools websocket upgrade failed"));
          return;
        }
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        // Transparent compositing, so the rounded icons keep transparent
        // corners (`omitBackground` alone is not always enough).
        Promise.all([
          command("Page.enable"),
          command("Runtime.enable"),
          command("Emulation.setDefaultBackgroundColorOverride", {
            color: { r: 0, g: 0, b: 0, a: 0 },
          }),
        ]).then(() => resolve({ command, close: () => socket.destroy() }));
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 1) {
          const message = JSON.parse(payload.toString());
          if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        }
        if (opcode === 8) return;
      }
    });
    socket.on("error", reject);
  });
}
