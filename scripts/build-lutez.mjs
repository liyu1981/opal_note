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
// The archive is built for **baseline** CPU features, not `native`. Zig's default
// target is the host machine, so a CI runner's newer CPU (AVX-512 on x86,
// dotprod/i8mm/SVE on ARM) bakes instructions into the archive that an older
// server does not have — the binary then dies with "Illegal instruction (core
// dumped)" on the first parse. Set OPALNOTE_LUTEZ_CPU=native for a local,
// same-machine speed build.
//
// The build is skipped when both artifacts are newer than every vendored source
// file, so a normal `pnpm build` costs nothing after the first run.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LUTEZ = path.join(ROOT, "vendor/lutez");
const STATIC_LIB = path.join(LUTEZ, "zig-out/lib/liblutez.a");
/** Records the target/CPU the artifacts were built for, so a change rebuilds. */
const STAMP = path.join(LUTEZ, "zig-out/lib/lutez-build-flags");
const WASM_OUT = path.join(LUTEZ, "zig-out/lib/lutez.wasm");
const WASM_PUBLIC = path.join(ROOT, "web/public/lutez.wasm");

function step(message) {
  console.log(`\n\u25b8 ${message}`);
}

const zig = process.env.OPALNOTE_ZIG ?? "zig";
const target = process.env.OPALNOTE_LUTEZ_TARGET ?? null;
// `baseline` keeps the archive portable across CPUs of the same architecture.
// `native` is only safe when the machine that builds is the machine that runs.
const cpu = process.env.OPALNOTE_LUTEZ_CPU ?? "baseline";
const buildFlags = `${target ?? "host"}|${cpu}`;
const libraryArgs = [
  "build",
  "-Doptimize=ReleaseSafe",
  `-Dcpu=${cpu}`,
  ...(target ? [`-Dtarget=${target}`] : []),
  "--prefix",
  "zig-out",
];

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
  if (!existsSync(STAMP) || readFileSync(STAMP, "utf8").trim() !== buildFlags) {
    return false;
  }
  // Watch the sources *and* the build graph: a changed flag or module layout
  // must rebuild even when no `.zig` file moved.
  const source = Math.max(
    newestMtime(path.join(LUTEZ, "src")),
    newestMtime(path.join(LUTEZ, "include")),
    statSync(path.join(LUTEZ, "build.zig")).mtimeMs,
    statSync(path.join(LUTEZ, "build.zig.zon")).mtimeMs,
  );
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

step(`Building the vendored lutez parser (${target ?? "host"} / ${cpu} CPU)`);
try {
  execFileSync(zig, libraryArgs, { cwd: LUTEZ, stdio: "inherit" });
  // The WASM module targets wasm32-freestanding and is architecture-independent,
  // so it must not see `-Dcpu`/`-Dtarget`: the vendored build reuses the library
  // module's target, and Zig then rejects an x86/ARM CPU model for wasm32.
  execFileSync(zig, ["build", "wasm", "--prefix", "zig-out"], {
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
mkdirSync(path.dirname(STAMP), { recursive: true });
writeFileSync(STAMP, `${buildFlags}\n`);
publishWasm();
console.log(
  `  wrote ${path.relative(ROOT, STATIC_LIB)} and ${path.relative(ROOT, WASM_PUBLIC)}`,
);
