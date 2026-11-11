import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const WEB_DIR = path.join(ROOT, "web");
export const WEB_DIST = path.join(WEB_DIR, "dist");

/**
 * Directory compiled into the Rust binary by `rust-embed`
 * (see `#[folder = "web/dist"]` in src/assets.rs).
 *
 * It is the same path as the Vite output today, so the sync step only
 * verifies the bundle. Keeping the two names explicit means a future split
 * (e.g. `server/assets`) copies instead of silently embedding stale files.
 */
export const SERVER_ASSETS = path.join(ROOT, "web/dist");

export function step(message) {
  console.log(`\n▸ ${message}`);
}

export function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

export function run(command, args) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function ensureWebDependencies() {
  if (existsSync(path.join(WEB_DIR, "node_modules"))) return;
  step("Installing web dependencies");
  run("pnpm", ["--dir", "web", "install", "--frozen-lockfile"]);
}

export function buildWeb() {
  step("Building the web client");
  run("pnpm", ["--dir", "web", "build"]);
}

/** Make sure the server has the freshly built bundle before it is compiled. */
export async function syncServerAssets() {
  step("Syncing the web bundle into the server");
  const index = path.join(WEB_DIST, "index.html");

  try {
    await stat(index);
  } catch {
    fail(`missing ${path.relative(ROOT, index)}; the web build produced no index.html`);
  }

  if (path.resolve(WEB_DIST) === path.resolve(SERVER_ASSETS)) {
    console.log("  server embeds web/dist directly; no copy needed");
    return;
  }

  await rm(SERVER_ASSETS, { recursive: true, force: true });
  await cp(WEB_DIST, SERVER_ASSETS, { recursive: true });
  console.log(`  copied ${path.relative(ROOT, WEB_DIST)} → ${path.relative(ROOT, SERVER_ASSETS)}`);
}

/** Args after `pnpm dev -- ...` / `pnpm start -- ...` (pnpm keeps the `--`). */
export function forwardedArgs() {
  const args = process.argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}

/** Value of `--name value` or `--name=value`, if present. */
export function flagValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1] ?? null;
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

export function serverBinary(release) {
  const name = process.platform === "win32" ? "opalnote.exe" : "opalnote";
  return path.join(ROOT, "target", release ? "release" : "debug", name);
}
