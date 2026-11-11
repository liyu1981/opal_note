#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";

import {
  ROOT,
  buildWeb,
  ensureWebDependencies,
  flagValue,
  forwardedArgs,
  run,
  serverBinary,
  step,
  syncServerAssets,
  tryRun,
} from "./lib.mjs";

// Development is one process: build the client, embed it, build and run the
// server, then watch client and server sources. Changes are debounced and
// coalesced so an editor save does not trigger a build storm. A successful
// client or server rebuild restarts the server.
const bind = process.env.OPALNOTE_BIND ?? "0.0.0.0:7827";
const dataDir = process.env.OPALNOTE_DATA_DIR ?? "./data";
const DEBOUNCE_MS = 220;
const STOP_TIMEOUT_MS = 4000;

const binary = serverBinary(false);
const extra = forwardedArgs();
const args = [];
// Defaults first, but let anything passed after `--` win (clap rejects a
// duplicated flag rather than overriding).
if (flagValue(extra, "--bind") === null) args.push("--bind", bind);
if (flagValue(extra, "--data-dir") === null) args.push("--data-dir", dataDir);
args.push(...extra);

const effectiveBind = flagValue(extra, "--bind") ?? bind;

ensureWebDependencies();
buildWeb();
await syncServerAssets();

step("Rebuilding the server");
run("cargo", ["build"]);

let child = null;
let stoppingChild = false;
let shuttingDown = false;
let buildInFlight = false;
let pendingClient = false;
let pendingServer = false;
let debounceTimer = null;
const watchers = [];

function startServer() {
  if (shuttingDown) return;

  step("Starting Opal Note in dev mode");
  console.log(`  ${path.relative(ROOT, binary)} ${args.join(" ")}`);
  console.log(`  → http://${effectiveBind.replace("0.0.0.0", "localhost")}\n`);

  const proc = spawn(binary, args, { cwd: ROOT, stdio: "inherit" });
  child = proc;

  proc.on("exit", (code, signal) => {
    if (child === proc) child = null;
    if (!stoppingChild && !shuttingDown) {
      console.log(
        `\n▸ Server exited (${signal ?? code ?? "unknown"}); watching for changes`,
      );
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      child = null;
      resolve();
      return;
    }

    child = null;
    stoppingChild = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      stoppingChild = false;
      resolve();
    };

    const killer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and the kill.
      }
      finish();
    }, STOP_TIMEOUT_MS);

    proc.once("exit", finish);
    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

async function restartServer() {
  step("Restarting server");
  await stopServer();
  startServer();
}

function scheduleFlush() {
  if (shuttingDown) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runPending();
  }, DEBOUNCE_MS);
}

function mark(kind) {
  if (shuttingDown) return;
  if (kind === "client") pendingClient = true;
  else pendingServer = true;
  scheduleFlush();
}

async function runPending() {
  if (shuttingDown || buildInFlight) return;
  buildInFlight = true;

  const rebuildClient = pendingClient;
  const rebuildServer = pendingServer;
  pendingClient = false;
  pendingServer = false;

  let ok = true;

  if (rebuildClient) {
    step("Client changed — rebuilding web bundle");
    ok = tryRun("pnpm", ["--dir", "web", "build"]) && ok;
  }

  if (rebuildServer) {
    step("Server changed — rebuilding binary");
    ok = tryRun("cargo", ["build"]) && ok;
  }

  if (ok && !shuttingDown) {
    await restartServer();
  } else if (!ok) {
    console.log("  keeping the current server until the next passing build");
  }

  buildInFlight = false;
  if (!shuttingDown && (pendingClient || pendingServer)) scheduleFlush();
}

const IGNORED_BASENAMES = new Set([".DS_Store", "4913"]);

function isIgnored(filename) {
  if (!filename) return false;
  const base = path.basename(filename);
  return (
    IGNORED_BASENAMES.has(base) ||
    base.startsWith(".#") ||
    base.endsWith("~") ||
    base.endsWith(".swp") ||
    base.endsWith(".swo") ||
    base.endsWith(".tmp")
  );
}

function addWatcher(target, recursive, onFile) {
  const absolute = path.resolve(ROOT, target);
  if (!existsSync(absolute)) return;

  try {
    const watcher = watch(
      absolute,
      { recursive },
      (_event, filename) => {
        const name = filename ? filename.toString() : null;
        if (isIgnored(name)) return;
        onFile(name);
      },
    );
    watcher.on("error", (error) => {
      console.warn(`  watch ${target}: ${error.message}`);
    });
    watchers.push(watcher);
  } catch (error) {
    console.warn(`  cannot watch ${target}: ${error.message}`);
  }
}

const CLIENT_CONFIG_FILES = new Set([
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "package.json",
]);
const SERVER_CONFIG_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
]);

function startWatchers() {
  step("Watching for changes");
  console.log("  client: web/src, web/public, web config files");
  console.log("  server: src, Cargo.toml, Cargo.lock, build.rs");
  console.log("  debounce: 220 ms · Ctrl+C to stop\n");

  addWatcher("web/src", true, () => mark("client"));
  addWatcher("web/public", true, () => mark("client"));
  addWatcher("web", false, (name) => {
    if (name && CLIENT_CONFIG_FILES.has(path.basename(name))) mark("client");
  });

  addWatcher("src", true, () => mark("server"));
  addWatcher(".", false, (name) => {
    if (name && SERVER_CONFIG_FILES.has(path.basename(name))) mark("server");
  });
}

async function shutdown(label) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n▸ ${label} received; shutting down`);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // Watcher may already be closed.
    }
  }
  await stopServer();
  process.exit(0);
}

startServer();
startWatchers();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
