#!/usr/bin/env node
// Build the vendored ReAgent checkout (`web/vendor/reagent`, a git submodule
// pinned in this repo). Its `package.json` points the exports at `dist/`, which
// the submodule does not commit, so the web build must produce it first.
//
// The build is skipped when `dist/` is newer than every source file, so a normal
// `pnpm build` costs nothing after the first run. A fresh `pnpm install` wipes
// `node_modules` but not the submodule, so `dist/` usually survives.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAGENT = path.join(ROOT, "web/vendor/reagent");
const DIST = path.join(REAGENT, "dist");

function step(message) {
  console.log(`\n\u25b8 ${message}`);
}

/** Newest mtime under `dir`, recursively. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function built() {
  const entry = path.join(DIST, "index.js");
  const types = path.join(DIST, "index.d.ts");
  if (!existsSync(entry) || !existsSync(types)) return false;
  const src = path.join(REAGENT, "src");
  if (!existsSync(src)) return false;
  return statSync(entry).mtimeMs >= newestMtime(src);
}

function fail(message) {
  console.error(`\n\u2716 ${message}`);
  process.exit(1);
}

if (!existsSync(REAGENT)) {
  fail(
    "web/vendor/reagent is missing. Run `git submodule update --init --recursive`.",
  );
}

if (built()) {
  process.exit(0);
}

if (!existsSync(path.join(REAGENT, "node_modules", "typescript"))) {
  fail(
    "web/vendor/reagent has no dependencies installed. Run `pnpm install` (from web/) first.",
  );
}

step("Building the vendored ReAgent");
try {
  execFileSync("pnpm", ["--dir", "web/vendor/reagent", "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  fail("ReAgent's build failed; the vendored checkout is not usable.");
}

if (!built()) fail("ReAgent's build produced no dist/index.js.");
console.log("  wrote web/vendor/reagent/dist");
