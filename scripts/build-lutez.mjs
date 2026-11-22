#!/usr/bin/env node
// Build the vendored `lutez` parser (`vendor/lutez`, a git submodule pinned in
// this repo) for both runtimes:
//
//   vendor/lutez/zig-out/lib/liblutez.a  → linked into the server by build.rs
//   web/public/lutez.wasm                → served to the browser, loaded by the
//                                          editor's block/task parser
//
// Zig 0.17.0 is pinned by the submodule (see `vendor/lutez/doc/PLAN.md` §12).
// Set OPALNOTE_SKIP_LUTEZ=1 to skip the build; the server then compiles with the
// legacy hand-written parser and the client keeps its legacy mirrors. When the
// submodule is absent but the artifacts exist (the Docker image copies them from
// a build stage), the script is a no-op.
//
// The build is skipped when both artifacts are newer than every vendored source
// file, so a normal `pnpm build` costs nothing after the first run.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LUTEZ = path.join(ROOT, "vendor/lutez");
const STATIC_LIB = path.join(LUTEZ, "zig-out/lib/liblutez.a");
const WASM_OUT = path.join(LUTEZ, "zig-out/lib/lutez.wasm");
const WASM_PUBLIC = path.join(ROOT, "web/public/lutez.wasm");

function step(message) {
  console.log(`\n\u25b8 ${message}`);
}

function fail(message) {
  console.error(`\n\u2716 ${message}`);
  process.exit(1);
}

/** Newest mtime under `dir`, recursively. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "zig-out" || entry.name === ".zig-cache") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function built() {
  if (!existsSync(STATIC_LIB) || !existsSync(WASM_OUT) || !existsSync(WASM_PUBLIC)) {
    return false;
  }
  const source = Math.max(newestMtime(path.join(LUTEZ, "src")), newestMtime(path.join(LUTEZ, "include")));
  return (
    statSync(STATIC_LIB).mtimeMs >= source &&
    statSync(WASM_OUT).mtimeMs >= source &&
    statSync(WASM_PUBLIC).mtimeMs >= statSync(WASM_OUT).mtimeMs
  );
}

function publishWasm() {
  mkdirSync(path.dirname(WASM_PUBLIC), { recursive: true });
  copyFileSync(WASM_OUT, WASM_PUBLIC);
}

if (process.env.OPALNOTE_SKIP_LUTEZ === "1") {
  console.log("  lutez: skipped (OPALNOTE_SKIP_LUTEZ=1)");
  process.exit(0);
}

if (!existsSync(path.join(LUTEZ, "build.zig"))) {
  // Packaging builds (the Docker image) hand us the compiled artifacts without
  // the submodule; skipping is correct there.
  if (existsSync(WASM_PUBLIC) && existsSync(STATIC_LIB)) {
    console.log("  lutez: using the prebuilt artifacts (no vendored sources)");
    process.exit(0);
  }
  fail(
    "vendor/lutez is missing. Run `git submodule update --init --recursive`, then `node scripts/build-lutez.mjs`.",
  );
}

if (built()) {
  process.exit(0);
}

const zig = process.env.OPALNOTE_ZIG ?? "zig";
const target = process.env.OPALNOTE_LUTEZ_TARGET ?? null;
const targetArgs = target ? ["-Dtarget=" + target] : [];

step("Building the vendored lutez parser");
try {
  execFileSync(
    zig,
    ["build", "-Doptimize=ReleaseSafe", "--prefix", "zig-out", ...targetArgs],
    { cwd: LUTEZ, stdio: "inherit" },
  );
  execFileSync(zig, ["build", "wasm", "--prefix", "zig-out", ...targetArgs], {
    cwd: LUTEZ,
    stdio: "inherit",
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    fail(
      "`zig` was not found. Install Zig 0.17.0 (https://ziglang.org/download), or set OPALNOTE_SKIP_LUTEZ=1 to build without the shared parser.",
    );
  }
  fail("lutez's build failed.");
}

if (!existsSync(STATIC_LIB)) fail("lutez produced no liblutez.a.");
if (!existsSync(WASM_OUT)) fail("lutez produced no lutez.wasm.");
publishWasm();
console.log(
  `  wrote ${path.relative(ROOT, STATIC_LIB)} and ${path.relative(ROOT, WASM_PUBLIC)}`,
);
