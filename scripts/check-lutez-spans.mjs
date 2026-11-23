#!/usr/bin/env node
// Span gate for the shared markdown parser (`web/src/lib/lutez/spans.ts`).
//
// lutez reports **byte** offsets; CodeMirror indexes **UTF-16 units** of a
// document with no `\r`. This checks the mapping on fixtures with emoji, CJK,
// CRLF, a lone CR and an empty body, then proves the general invariant over the
// notes in `data/notebooks`: for every AST node, mapping its normalized span to
// UTF-16 and slicing the normalized text yields exactly the normalized bytes the
// node covers. A mismatch means a decoration would land on the wrong characters.
//
// Usage: node scripts/check-lutez-spans.mjs   (needs `node scripts/build-lutez.mjs` once)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTES = path.join(ROOT, "data/notebooks");
const WASM = path.join(ROOT, "web/public/lutez.wasm");

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!existsSync(WASM)) {
  console.log("no web/public/lutez.wasm; run `node scripts/build-lutez.mjs` first");
  process.exit(0);
}

const harness = `
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createLutezEngine } from "./glue";
import { parseDocument } from "./parse";
import { normalizeText, span16, text16 } from "./spans";
import { NODE } from "./wire";

const engine = await createLutezEngine(readFileSync(${JSON.stringify(WASM)}));
const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) failures.push(label + ": got " + a + ", want " + b);
};

const parse = (body) => engine.withAst(body, (bytes) => parseDocument(bytes, body));
const decoder = new TextDecoder();

function spanOf(body, predicate) {
  const document = parse(body);
  if (!document) throw new Error("no document for " + JSON.stringify(body));
  const node = document.nodes.find(predicate);
  if (!node) throw new Error("no node for " + JSON.stringify(body));
  const [from, to] = span16(node, document.mapper);
  return { document, node, from, to, slice: document.text.slice(from, to) };
}

// ---- 1. ASCII stays byte == unit ---------------------------------------
{
  const document = parse("- [ ] buy milk #tag");
  check("ascii identity", document.mapper.identity, true);
  const tag = spanOf("- [ ] buy milk #tag", (n) => n.kind === NODE.inlineExtension);
  check("ascii tag span", [tag.from, tag.to], [15, 19]);
  check("ascii tag text", tag.slice, "#tag");
  const item = spanOf("- [ ] buy milk #tag", (n) => n.kind === NODE.listItem);
  check("ascii item span", [item.from, item.to], [0, 19]);
}

// ---- 2. multi-byte characters shift byte offsets ------------------------
{
  const body = "café 🎉 **bold** tail";
  const strong = spanOf(body, (n) => n.kind === 22); // NodeStrong
  check("emoji strong span", [strong.from, strong.to], [8, 16]);
  check("emoji strong text", strong.slice, "**bold**");
  const paragraph = spanOf(body, (n) => n.kind === NODE.paragraph);
  check("emoji paragraph span", [paragraph.from, paragraph.to], [0, 21]);
  check("emoji text length", paragraph.document.text.length, 21);
}

// ---- 3. CJK -------------------------------------------------------------
{
  const body = "中文笔记 #标签 and [[页面]]";
  const wikilink = spanOf(body, (n) => n.kind === NODE.inlineExtension && n.extKind === 2);
  check("cjk wikilink span", [wikilink.from, wikilink.to], [13, 19]);
  check("cjk wikilink text", wikilink.slice, "[[页面]]");
}

// ---- 4. CRLF and a lone CR are normalized away --------------------------
{
  const body = "- a\\r\\n- b #tag\\r\\n";
  const tag = spanOf(body, (n) => n.kind === NODE.inlineExtension);
  check("crlf tag span", [tag.from, tag.to], [8, 12]);
  check("crlf tag text", tag.slice, "#tag");
  check("crlf text", tag.document.text, "- a\\n- b #tag\\n");
  const second = spanOf(body, (n) => n.kind === NODE.listItem && n.rawStart === 5);
  check("crlf item span", [second.from, second.to], [4, 12]);
}
{
  const body = "- a\\r- b #tag\\r";
  const tag = spanOf(body, (n) => n.kind === NODE.inlineExtension);
  check("lone-cr tag span", [tag.from, tag.to], [8, 12]);
  check("lone-cr text", tag.document.text, "- a\\n- b #tag\\n");
}

// ---- 5. an empty body is a single zero-width node ----------------------
{
  const document = parse("");
  check("empty nodes", document.nodes.length, 1);
  const [from, to] = span16(document.nodes[0], document.mapper);
  check("empty span", [from, to], [0, 0]);
  check("empty text", document.text, "");
}

// ---- 6. the general invariant over the corpus --------------------------
let notes = 0;
let nodes = 0;
if (${JSON.stringify(existsSync(NOTES))}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(${JSON.stringify(NOTES)});
  const splitFrontmatter = (raw) => {
    const text = raw.startsWith("\\uFEFF") ? raw.slice(1) : raw;
    if (!text.startsWith("---\\n") && !text.startsWith("---\\r\\n")) return text;
    const rest = text.slice(text.indexOf("\\n") + 1);
    let offset = 0;
    for (const line of rest.split(/(?<=\\n)/u)) {
      if (line.replace(/[\\r\\n]+$/u, "") === "---") return rest.slice(offset + line.length);
      offset += line.length;
    }
    return text;
  };
  for (const file of files) {
    const body = splitFrontmatter(readFileSync(file, "utf8"));
    if (body.startsWith("\\uFEFF")) {
      failures.push(path.relative(${JSON.stringify(NOTES)}, file) + ": body still has a BOM");
      continue;
    }
    const document = parse(body);
    if (!document) {
      failures.push(path.relative(${JSON.stringify(NOTES)}, file) + ": parse failed");
      continue;
    }
    notes += 1;
    const raw = new TextEncoder().encode(body);
    for (const node of document.nodes) {
      nodes += 1;
      const expected = normalizeText(decoder.decode(raw.slice(node.rawStart, node.rawEnd)));
      const actual = text16(document.text, node, document.mapper);
      if (actual !== expected) {
        const [from, to] = span16(node, document.mapper);
        failures.push(
          path.relative(${JSON.stringify(NOTES)}, file) +
            ": node " + node.kind + " cm=[" + from + "," + to + ") got " +
            JSON.stringify(actual.slice(0, 40)) + " want " + JSON.stringify(expected.slice(0, 40)),
        );
        if (failures.length > 20) break;
      }
    }
    if (failures.length > 20) break;
  }
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, 20)) console.error("  " + failure);
  console.error("\\n✖ " + failures.length + " span mismatch(es)");
  process.exit(1);
}
const suffix = ${JSON.stringify(existsSync(NOTES))}
  ? ", " + nodes + " nodes over " + notes + " notes match their normalized source"
  : "";
console.log("✓ spans: fixtures ok" + suffix);
`;

const bundlePath = path.join(tmpdir(), `opalnote-lutez-spans-${process.pid}.mjs`);
try {
  await build({
    stdin: {
      contents: harness,
      resolveDir: path.join(ROOT, "web/src/lib/lutez"),
      loader: "ts",
      sourcefile: "lutez-spans-harness.ts",
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

let run;
try {
  run = spawnSync(process.execPath, [bundlePath], { cwd: ROOT, encoding: "utf8" });
} finally {
  rmSync(bundlePath, { force: true });
}
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
process.exit(run.status ?? 1);
