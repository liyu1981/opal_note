#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, fail, step } from "./lib.mjs";

const dir = path.join(ROOT, "certs");
const cert = path.join(dir, "localhost.pem");
const key = path.join(dir, "localhost-key.pem");

mkdirSync(dir, { recursive: true });
step("Generating local HTTPS certificates with mkcert");

const result = spawnSync(
  "mkcert",
  [
    "-cert-file",
    cert,
    "-key-file",
    key,
    "localhost",
    "127.0.0.1",
    "::1",
  ],
  { cwd: ROOT, stdio: "inherit", env: process.env },
);

if (result.error) {
  fail(
    `mkcert is required for local HTTPS: ${result.error.message}\n` +
      "Install mkcert and run `mkcert -install`, then retry `pnpm certs`.",
  );
}
if (result.status !== 0) {
  fail(
    "mkcert failed. Run `mkcert -install` first, then retry `pnpm certs`.",
  );
}

console.log(`\n  certificate: ${path.relative(ROOT, cert)}`);
console.log(`  key:         ${path.relative(ROOT, key)}\n`);
