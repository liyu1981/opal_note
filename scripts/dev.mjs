#!/usr/bin/env node
import { spawn } from "node:child_process";
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
} from "./lib.mjs";

// Development is a single, production-like process: build the client, embed
// it, rebuild the server, then run it. There is no separate Vite server.
const bind = process.env.OPALNOTE_BIND ?? "0.0.0.0:7827";
const dataDir = process.env.OPALNOTE_DATA_DIR ?? "./data";

ensureWebDependencies();
buildWeb();
await syncServerAssets();

step("Rebuilding the server");
run("cargo", ["build"]);

step("Starting Opal Note in dev mode");
const binary = serverBinary(false);
const extra = forwardedArgs();
const args = [];
// Defaults first, but let anything passed after `--` win (clap rejects a
// duplicated flag rather than overriding).
if (flagValue(extra, "--bind") === null) args.push("--bind", bind);
if (flagValue(extra, "--data-dir") === null) args.push("--data-dir", dataDir);
args.push(...extra);

const effectiveBind = flagValue(extra, "--bind") ?? bind;
console.log(`  ${path.relative(ROOT, binary)} ${args.join(" ")}`);
console.log(`  → http://${effectiveBind.replace("0.0.0.0", "localhost")}\n`);

const child = spawn(binary, args, { cwd: ROOT, stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 0 : (code ?? 0));
});
