#!/usr/bin/env node
// Parity gate for the shared markdown parser (`doc/lutez-parser.md`).
//
// Both runtimes derive blocks, tasks, tags and wikilinks from the same `lutez`
// AST, through two hand-written adapters:
//
//   server: `mod lutez_ast` in `src/store/markdown.rs` (FFI, `liblutez.a`)
//   client: `web/src/lib/lutez/parse.ts`            (WASM, `lutez.wasm`)
//
// This script dumps the server's rows from the ignored `corpus_parity` test,
// bundles the client adapter with esbuild, runs it over the same notes, and
// diffs the two. A non-zero diff means the editor would draw a different block
// list than the one the index stores.
//
// Usage: node scripts/check-lutez-parity.mjs   (needs `node scripts/build-lutez.mjs` once)
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTES = path.join(ROOT, "data/notebooks");

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!readdirSync(ROOT).includes("data")) {
  console.log("no data/notebooks; nothing to compare");
  process.exit(0);
}

// ---- server side ---------------------------------------------------------

const server = spawnSync(
  "cargo",
  ["test", "--bin", "opalnote", "corpus_parity", "--", "--ignored", "--nocapture"],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, OPALNOTE_PARITY_DUMP: "1" },
  },
);
if (server.status !== 0) fail("the server-side corpus harness failed; run it directly for details");
const serverRows = server.stdout
  .split("\n")
  .filter((line) => line.includes("\t") && line.includes(".md"));
if (serverRows.length === 0) fail("the server-side harness produced no rows");

// ---- client side --------------------------------------------------------

const harness = `
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createLutezEngine } from "./glue";
import { astTags, astWikilinks, parseAstContent } from "./parse";
import { normalizeLinkTarget, splitWikilink } from "../markdown";

const ROOT = ${JSON.stringify(NOTES)};

function splitFrontmatter(raw) {
  const text = raw.startsWith("\\uFEFF") ? raw.slice(1) : raw;
  if (!text.startsWith("---\\n") && !text.startsWith("---\\r\\n")) return text;
  const rest = text.slice(text.indexOf("\\n") + 1);
  let offset = 0;
  for (const line of rest.split(/(?<=\\n)/u)) {
    const content = line.replace(/[\\r\\n]+$/u, "");
    if (content === "---") return rest.slice(offset + line.length);
    offset += line.length;
  }
  return text;
}

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const engine = await createLutezEngine(readFileSync(${JSON.stringify(path.join(ROOT, "web/public/lutez.wasm"))}));
const lines = [];
for (const file of files(ROOT).sort()) {
  const body = splitFrontmatter(readFileSync(file, "utf8"));
  const content = engine.withAst(body, (bytes) => parseAstContent(bytes, body));
  if (!content) {
    lines.push("FAIL\\t" + path.relative(ROOT, file));
    continue;
  }
  const blocks = content.blocks
    .map((b) => b.kind + "@" + b.startLine + "-" + b.endLine + "#" + b.depth + ">" + b.parentSeq)
    .join(" ");
  const tasks = content.tasks.map((t) => t.line + ":" + t.status + ":" + t.text).join(" ");
  const tags = engine.withAst(body, (bytes) => astTags(bytes)) ?? [];
  const links = [];
  for (const raw of engine.withAst(body, (bytes) => astWikilinks(bytes)) ?? []) {
    const target = normalizeLinkTarget(splitWikilink(raw).target);
    if (target && !links.includes(target)) links.push(target);
  }
  lines.push(
    [
      path.relative(ROOT, file),
      blocks,
      tasks,
      tags.join(","),
      links.join(","),
    ].join("\\t"),
  );
}
process.stdout.write(lines.join("\\n") + "\\n");
`;

const bundlePath = path.join(tmpdir(), `opalnote-lutez-parity-${process.pid}.mjs`);
try {
  await build({
    stdin: {
      contents: harness,
      resolveDir: path.join(ROOT, "web/src/lib/lutez"),
      loader: "ts",
      sourcefile: "lutez-parity-harness.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "warning",
    outfile: bundlePath,
  });
} catch (error) {
  fail(`esbuild failed: ${error?.message ?? error}`);
}

const client = spawnSync(process.execPath, [bundlePath], { cwd: ROOT, encoding: "utf8" });
rmSync(bundlePath, { force: true });
if (client.status !== 0) fail(`the client harness failed: ${client.stderr}`);
const clientRows = client.stdout.split("\n").filter((line) => line.length > 0);

// ---- diff ---------------------------------------------------------------

const serverByPath = new Map(
  serverRows.map((line) => [line.slice(0, line.indexOf("\t")), line]),
);
const clientByPath = new Map(
  clientRows.map((line) => [line.slice(0, line.indexOf("\t")), line]),
);

const paths = [...new Set([...serverByPath.keys(), ...clientByPath.keys()])].sort();
const differences = paths.filter(
  (note) => serverByPath.get(note) !== clientByPath.get(note),
);

console.log(`notes: ${paths.length}`);
console.log(`server rows: ${serverRows.length}, client rows: ${clientRows.length}`);
if (differences.length === 0) {
  console.log("\n✓ the server and the browser derive identical blocks, tasks, tags and links");
  process.exit(0);
}

console.error(`\n✖ ${differences.length} note(s) parse differently:`);
for (const note of differences.slice(0, 20)) {
  console.error(`\n${note}`);
  console.error(`  server: ${serverByPath.get(note) ?? "(missing)"}`);
  console.error(`  client: ${clientByPath.get(note) ?? "(missing)"}`);
}
process.exit(1);
