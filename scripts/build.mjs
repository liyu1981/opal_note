#!/usr/bin/env node
import path from "node:path";

import {
  ROOT,
  buildWeb,
  ensureWebDependencies,
  run,
  serverBinary,
  step,
  syncServerAssets,
} from "./lib.mjs";

ensureWebDependencies();
buildWeb();
await syncServerAssets();

step("Building the server (release)");
run("cargo", ["build", "--release", "--locked"]);

step("Single binary ready");
console.log(`  ${path.relative(ROOT, serverBinary(true))}`);
