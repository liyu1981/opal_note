#!/usr/bin/env node
/**
 * Build built-in plugins and backgrounds from their package.json sources.
 *
 * Source:
 *   builtin/src/plugins/<domain>/<extension>/package.json
 *   builtin/src/backgrounds/<domain>/<extension>/package.json
 *
 * Generated release assets:
 *   builtin/plugins/<domain>/<extension>/
 *   builtin/backgrounds/<domain>/<extension>/
 */

import { build } from "esbuild";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ROOT, fail, step } from "./lib.mjs";

const PLUGIN_SOURCE = path.join(ROOT, "builtin", "src", "plugins");
const BACKGROUND_SOURCE = path.join(ROOT, "builtin", "src", "backgrounds");
const PLUGIN_OUTPUT = path.join(ROOT, "builtin", "plugins");
const BACKGROUND_OUTPUT = path.join(ROOT, "builtin", "backgrounds");

const MAX_PLUGIN_BYTES = 20_000;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_ID_CHARS = 96;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 500;

const args = process.argv.slice(2);
const check = args.includes("--check");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

if (onlyIndex >= 0 && (!only || only.startsWith("-"))) {
  fail("--only requires a plugin or background id");
}

function count(value) {
  return [...value].length;
}

function validId(id) {
  if (typeof id !== "string" || count(id) > MAX_ID_CHARS) return false;
  const parts = id.split("/");
  if (parts.length !== 2) return false;
  return parts.every(
    (part) =>
      part.length > 0 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part),
  );
}

function validateManifest(pkg, sourceLabel, expectedKind) {
  const manifest = pkg.opal_note;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${sourceLabel}: package.json needs an "opal_note" object`);
  }
  if (!validId(manifest.id)) {
    throw new Error(
      `${sourceLabel}: opal_note.id must be "<domain>/<extension>" with letters, digits, "-", "_" and "."`,
    );
  }
  if (
    typeof manifest.title !== "string" ||
    !manifest.title.trim() ||
    count(manifest.title.trim()) > MAX_TITLE_CHARS
  ) {
    throw new Error(`${sourceLabel}: opal_note.title is invalid`);
  }
  if (
    typeof manifest.description !== "string" ||
    !manifest.description.trim() ||
    count(manifest.description.trim()) > MAX_DESCRIPTION_CHARS
  ) {
    throw new Error(`${sourceLabel}: opal_note.description is invalid`);
  }
  if (expectedKind === "background") {
    if (typeof manifest.kind !== "string" || !manifest.kind.trim()) {
      throw new Error(`${sourceLabel}: background opal_note.kind is required`);
    }
    if (
      manifest.options !== undefined &&
      (typeof manifest.options !== "object" ||
        manifest.options === null ||
        Array.isArray(manifest.options))
    ) {
      throw new Error(`${sourceLabel}: background opal_note.options must be an object`);
    }
  }
  return manifest;
}

async function discoverPackages(root, label) {
  if (!existsSync(root)) return [];
  const found = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name));
    }
  }

  await walk(root);
  return found.map((dir) => ({ dir, label }));
}

async function readPackage(dir) {
  const packagePath = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`${packagePath}: ${error.message}`);
  }
  return pkg;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function buildPlugin(packageDir, manifest, buildConfig = {}) {
  const entryName = buildConfig.entry ?? manifest.entry ?? "src/index.js";
  const entry = path.resolve(packageDir, entryName);
  if (!inside(packageDir, entry)) {
    throw new Error(`${manifest.id}: entry escapes the package directory`);
  }
  if (!existsSync(entry)) {
    throw new Error(`${manifest.id}: missing entry ${entryName}`);
  }

  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "__opalnote_plugin",
    platform: "neutral",
    target: buildConfig.target ?? "es2020",
    minify: buildConfig.minify !== false,
    write: false,
    logLevel: "silent",
  });
  const bundled = result.outputFiles[0]?.text;
  if (!bundled) throw new Error(`${manifest.id}: esbuild produced no script`);

  const script = `(function () {\n${bundled}\nconst __plugin = __opalnote_plugin.default || __opalnote_plugin;\nconst __result = typeof __plugin === "function" ? __plugin() : __plugin;\nreturn typeof __result === "string" ? __result : JSON.stringify(__result);\n})()\n`;
  const bytes = Buffer.byteLength(script);
  if (bytes > MAX_PLUGIN_BYTES) {
    throw new Error(
      `${manifest.id}: plugin.js is ${bytes} bytes; maximum is ${MAX_PLUGIN_BYTES}`,
    );
  }

  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) {
    throw new Error(`${manifest.id}: plugin.json exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return { script, json };
}

async function buildOne(kind, packageDir, outputRoot) {
  const pkg = await readPackage(packageDir);
  const manifest = validateManifest(
    pkg,
    path.relative(ROOT, packageDir),
    kind,
  );
  const destination = path.join(outputRoot, manifest.id);
  if (!inside(outputRoot, destination)) {
    throw new Error(`${manifest.id}: output escapes ${outputRoot}`);
  }

  if (kind === "plugin") {
    const { script, json } = await buildPlugin(
      packageDir,
      manifest,
      pkg.opal_note_build ?? {},
    );
    return { id: manifest.id, files: { "plugin.js": script, "plugin.json": json } };
  }

  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) {
    throw new Error(
      `${manifest.id}: background.json exceeds ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  if (manifest.options && JSON.stringify(manifest.options).length > 32 * 1024) {
    throw new Error(`${manifest.id}: background options exceed 32 KiB`);
  }
  return { id: manifest.id, manifest: json };
}

async function writePlugin(outputRoot, built) {
  const destination = path.join(outputRoot, built.id);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const [name, content] of Object.entries(built.files)) {
    await writeFile(path.join(destination, name), content);
  }
}

async function writeBackground(outputRoot, packageDir, built) {
  const destination = path.join(outputRoot, built.id);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "background.json"), built.manifest);
  for (const entry of await readdir(packageDir, { withFileTypes: true })) {
    if (entry.name === "package.json") continue;
    await cp(
      path.join(packageDir, entry.name),
      path.join(destination, entry.name),
      { recursive: true, force: true },
    );
  }
}

async function compareTree(expected, actual) {
  if (!existsSync(actual)) return [`missing generated directory ${actual}`];
  const errors = [];
  const expectedEntries = await readdir(expected, { withFileTypes: true });
  for (const entry of expectedEntries) {
    const left = path.join(expected, entry.name);
    const right = path.join(actual, entry.name);
    if (entry.isDirectory()) {
      errors.push(...(await compareTree(left, right)));
    } else {
      if (!existsSync(right)) {
        errors.push(`missing ${right}`);
        continue;
      }
      const [a, b] = await Promise.all([readFile(left), readFile(right)]);
      if (!a.equals(b)) errors.push(`content differs: ${right}`);
    }
  }
  if (existsSync(actual)) {
    for (const entry of await readdir(actual)) {
      if (!expectedEntries.some((item) => item.name === entry)) {
        errors.push(`unexpected generated file: ${path.join(actual, entry)}`);
      }
    }
  }
  return errors;
}

async function main() {
  const pluginPackages = await discoverPackages(PLUGIN_SOURCE, "plugin");
  const backgroundPackages = await discoverPackages(
    BACKGROUND_SOURCE,
    "background",
  );
  if (pluginPackages.length === 0 && backgroundPackages.length === 0) {
    fail("no builtin packages found under builtin/src");
  }

  const selectedPlugins = only
    ? pluginPackages.filter(({ dir }) => {
        const id = path.relative(PLUGIN_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : pluginPackages;
  const selectedBackgrounds = only
    ? backgroundPackages.filter(({ dir }) => {
        const id = path.relative(BACKGROUND_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : backgroundPackages;

  const builtPlugins = [];
  for (const { dir } of selectedPlugins) {
    const built = await buildOne("plugin", dir, PLUGIN_OUTPUT);
    builtPlugins.push({ dir, built });
  }
  const builtBackgrounds = [];
  for (const { dir } of selectedBackgrounds) {
    const built = await buildOne("background", dir, BACKGROUND_OUTPUT);
    builtBackgrounds.push({ dir, built });
  }

  if (check) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "opalnote-builtins-"));
    const tempPlugins = path.join(temp, "plugins");
    const tempBackgrounds = path.join(temp, "backgrounds");
    try {
      for (const { built } of builtPlugins) await writePlugin(tempPlugins, built);
      for (const { dir, built } of builtBackgrounds) {
        await writeBackground(tempBackgrounds, dir, built);
      }
      const errors = [
        ...(await compareTree(tempPlugins, PLUGIN_OUTPUT)),
        ...(await compareTree(tempBackgrounds, BACKGROUND_OUTPUT)),
      ];
      if (errors.length > 0) {
        fail(`generated built-ins are out of date:\n  ${errors.join("\n  ")}`);
      }
      console.log(
        `  ${builtPlugins.length} plugin(s) and ${builtBackgrounds.length} background(s) are up to date`,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return;
  }

  if (!only) {
    await rm(PLUGIN_OUTPUT, { recursive: true, force: true });
    await rm(BACKGROUND_OUTPUT, { recursive: true, force: true });
  }
  await mkdir(PLUGIN_OUTPUT, { recursive: true });
  await mkdir(BACKGROUND_OUTPUT, { recursive: true });

  for (const { built } of builtPlugins) await writePlugin(PLUGIN_OUTPUT, built);
  for (const { dir, built } of builtBackgrounds) {
    await writeBackground(BACKGROUND_OUTPUT, dir, built);
  }

  console.log(
    `  wrote ${builtPlugins.length} plugin(s) and ${builtBackgrounds.length} background(s)`,
  );
}

step(`Building built-ins${check ? " (check only)" : ""}`);
try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
