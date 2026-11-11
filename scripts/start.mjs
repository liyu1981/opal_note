#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { ROOT, fail, forwardedArgs, serverBinary, step } from "./lib.mjs";

const binary = serverBinary(true);
if (!existsSync(binary)) {
  fail(`missing ${path.relative(ROOT, binary)}; run \`pnpm build\` first`);
}

step("Starting the release binary");
const args = forwardedArgs();
console.log(`  ${path.relative(ROOT, binary)} ${args.join(" ")}\n`);

const child = spawn(binary, args, {
  cwd: ROOT,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 0 : (code ?? 0));
});
