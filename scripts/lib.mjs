import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, rm, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const WEB_DIR = path.join(ROOT, "web");
export const WEB_DIST = path.join(WEB_DIR, "dist");

/**
 * Directory embedded by release builds (see `#[folder = "web/dist"]` in
 * src/assets.rs). Debug builds read this directory from disk at runtime.
 * It is the same path as the Vite output today, so the sync step only verifies
 * the bundle.
 */
export const SERVER_ASSETS = path.join(ROOT, "web/dist");

export function step(message) {
  console.log(`\n▸ ${message}`);
}

export function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** Run a command, reporting but not exiting on failure (watch mode). */
export function tryRun(command, args) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`  ✖ ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`  ✖ ${command} exited with ${result.status}`);
    return false;
  }
  return true;
}

export function run(command, args) {
  if (!tryRun(command, args)) process.exit(1);
}

/**
 * Hosts the dev certificate must cover: localhost plus every non-internal IPv4
 * address, so `https://<lan-ip>:7827` is a properly secured origin. Browsers
 * refuse service workers (and therefore PWA installation) on a certificate
 * whose SANs do not include the URL host. `OPALNOTE_TLS_HOSTS` adds names/IPs
 * (for example a tunnel or proxy hostname).
 */
export function devCertificateNames() {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const value of String(process.env.OPALNOTE_TLS_HOSTS ?? "").split(",")) {
    if (value.trim()) names.add(value.trim());
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (!address.internal && address.family === "IPv4") {
        names.add(address.address);
      }
    }
  }
  return [...names];
}

/** True when the PEM certificate covers every DNS name and IPv4 host. */
export function certificateCovers(certPath, names) {
  try {
    const certificate = new X509Certificate(readFileSync(certPath));
    const alt = certificate.subjectAltName ?? "";
    return names
      .filter((name) => !name.includes(":"))
      .every((name) =>
        /^\d+\.\d+\.\d+\.\d+$/u.test(name)
          ? alt.includes(`IP Address:${name}`)
          : alt.includes(`DNS:${name}`),
      );
  } catch {
    return false;
  }
}

/**
 * Create local mkcert certificates when TLS is enabled. Missing files and a
 * certificate that does not cover the current LAN addresses both regenerate it,
 * which is what makes the PWA installable from another device on the LAN.
 */
export function ensureDevCerts(args) {
  if (
    args.includes("--no-tls") ||
    ["1", "true", "yes"].includes(
      String(process.env.OPALNOTE_NO_TLS ?? "").toLowerCase(),
    )
  ) {
    return;
  }
  const cert = path.join(ROOT, "certs", "localhost.pem");
  const key = path.join(ROOT, "certs", "localhost-key.pem");
  if (
    existsSync(cert) &&
    existsSync(key) &&
    certificateCovers(cert, devCertificateNames())
  ) {
    return;
  }
  step("Preparing local HTTPS certificates");
  run("node", ["scripts/certs.mjs"]);
}

export function ensureRootDependencies() {
  if (existsSync(path.join(ROOT, "node_modules", "esbuild"))) return;
  step("Installing built-in build dependencies");
  run("pnpm", ["install", "--frozen-lockfile"]);
}

export function ensureWebDependencies() {
  if (existsSync(path.join(WEB_DIR, "node_modules"))) return;
  step("Installing web dependencies");
  run("pnpm", ["--dir", "web", "install", "--frozen-lockfile"]);
}

export function buildBuiltins() {
  step("Building built-in plugins and backgrounds");
  run("node", ["scripts/build-builtins.mjs"]);
}

export function buildLutez() {
  step("Building the vendored markdown parser (lutez)");
  run("node", ["scripts/build-lutez.mjs"]);
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
