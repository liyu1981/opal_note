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
// Excalidraw ships ~14 MB of self-hosted fonts (including the CJK Xiaolai
// ranges), so viewer bundles need more room than code-only plugins.
const MAX_VIEWER_BYTES = 32 * 1024 * 1024;
const MAX_VIEWER_EXTENSIONS = 8;
const VIEWER_CSP_DIRECTIVES = ["connect-src", "font-src", "img-src", "media-src", "style-src"];

function viewerCspAllowed(directive, source) {
  if (source === "'self'" || source === "data:" || source === "blob:") return true;
  return source === "'unsafe-inline'" && directive === "style-src";
}

function validateViewerCsp(sourceLabel, csp) {
  if (csp === undefined) return;
  if (!csp || typeof csp !== "object" || Array.isArray(csp)) {
    throw new Error(`${sourceLabel}: viewer opal_note.csp must be an object`);
  }
  for (const [directive, sources] of Object.entries(csp)) {
    if (!VIEWER_CSP_DIRECTIVES.includes(directive)) {
      throw new Error(
        `${sourceLabel}: csp directive "${directive}" is not allowed; use ${VIEWER_CSP_DIRECTIVES.join(", ")}`,
      );
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error(`${sourceLabel}: csp "${directive}" needs a source list`);
    }
    for (const source of sources) {
      if (typeof source !== "string" || !viewerCspAllowed(directive, source)) {
        throw new Error(
          `${sourceLabel}: csp source "${source}" is not allowed in "${directive}"`,
        );
      }
    }
  }
}
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
  const expectedType =
    expectedKind === "plugin"
      ? "server"
      : expectedKind === "client"
        ? "client"
        : expectedKind === "viewer"
          ? "viewer"
          : null;
  if (expectedType && manifest.type !== expectedType) {
    throw new Error(
      `${sourceLabel}: opal_note.type must be "${expectedType}" for this package location`,
    );
  }
  if (expectedKind === "viewer") {
    const extensions = manifest.extensions;
    if (
      !Array.isArray(extensions) ||
      extensions.length === 0 ||
      extensions.length > MAX_VIEWER_EXTENSIONS
    ) {
      throw new Error(
        `${sourceLabel}: viewer opal_note.extensions must list 1-${MAX_VIEWER_EXTENSIONS} entries`,
      );
    }
    for (const extension of extensions) {
      if (
        typeof extension !== "string" ||
        !/^[a-z0-9]{1,16}$/u.test(extension)
      ) {
        throw new Error(
          `${sourceLabel}: viewer extension \`${extension}\` must be lower-case letters and digits`,
        );
      }
    }
    if (
      typeof manifest.entry !== "string" ||
      !manifest.entry.endsWith(".html") ||
      manifest.entry.startsWith("/") ||
      manifest.entry.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(
        `${sourceLabel}: viewer opal_note.entry must be a relative .html path`,
      );
    }
    if (manifest.role !== "renderer" && manifest.role !== "editor") {
      throw new Error(
        `${sourceLabel}: viewer opal_note.role must be "renderer" or "editor"`,
      );
    }
    validateViewerCsp(sourceLabel, manifest.csp);
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

async function buildClientPlugin(packageDir, manifest, buildConfig = {}) {
  const entryName = buildConfig.entry ?? "src/index.tsx";
  const entry = path.resolve(packageDir, entryName);
  if (!inside(packageDir, entry)) {
    throw new Error(`${manifest.id}: client entry escapes the package directory`);
  }
  if (!existsSync(entry)) {
    throw new Error(`${manifest.id}: missing client entry ${entryName}`);
  }
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    target: buildConfig.target ?? "es2020",
    minify: false,
    write: false,
    logLevel: "silent",
    external: ["@app/*", "react", "react/jsx-runtime"],
  });
  const script = result.outputFiles[0]?.text;
  if (!script) throw new Error(`${manifest.id}: esbuild produced no client script`);
  const json = JSON.stringify(manifest, null, 2) + "\n";
  return { script, json };
}

async function buildViewerPlugin(packageDir, manifest, buildConfig = {}) {
  const entryName = buildConfig.entry ?? "src/index.ts";
  const entry = path.resolve(packageDir, entryName);
  if (!inside(packageDir, entry)) {
    throw new Error(`${manifest.id}: viewer entry escapes the package directory`);
  }
  if (!existsSync(entry)) {
    throw new Error(`${manifest.id}: missing viewer entry ${entryName}`);
  }
  const outdir = await mkdtemp(path.join(os.tmpdir(), "opalnote-viewer-"));
  try {
    const result = await build({
      absWorkingDir: packageDir,
      entryPoints: [entry],
      outdir,
      bundle: true,
      format: "iife",
      jsx: "automatic",
      platform: "browser",
      target: buildConfig.target ?? "es2020",
      minify: buildConfig.minify !== false,
      conditions: ["production", "browser"],
      write: false,
      logLevel: "silent",
      loader: {
        ".woff2": "file",
        ".woff": "file",
        ".ttf": "file",
        ".png": "file",
        ".jpg": "file",
        ".gif": "file",
        ".svg": "file",
      },
      assetNames: "[name]-[hash]",
    });

    const files = {};
    let css = null;
    for (const file of result.outputFiles) {
      const rel = path.relative(outdir, file.path).split(path.sep).join("/");
      if (rel.endsWith(".js") && !files["viewer.js"]) {
        files["viewer.js"] = file.contents;
      } else if (rel.endsWith(".css") && !css) {
        css = file.contents;
      } else {
        files[rel] = file.contents;
      }
    }
    if (!files["viewer.js"]) {
      throw new Error(`${manifest.id}: esbuild produced no viewer script`);
    }
    if (css) files["viewer.css"] = css;

    const htmlPath = path.join(packageDir, "viewer.html");
    files[manifest.entry] = existsSync(htmlPath)
      ? await readFile(htmlPath)
      : Buffer.from(
          [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '<meta charset="utf-8" />',
            '<meta name="viewport" content="width=device-width, initial-scale=1" />',
            css ? '<link rel="stylesheet" href="viewer.css" />' : null,
            "<style>html,body{margin:0;height:100%;}body{overflow:hidden;}</style>",
            "</head>",
            "<body>",
            '<div id="root"></div>',
            '<script src="viewer.js"></script>',
            "</body>",
            "</html>",
            "",
          ]
            .filter((line) => line !== null)
            .join("\n"),
        );

    // Extra static files (`copy` entries) such as Excalidraw's fonts.
    for (const copy of buildConfig.copy ?? []) {
      if (
        !copy ||
        typeof copy.from !== "string" ||
        typeof copy.to !== "string" ||
        copy.to.startsWith("/") ||
        copy.to.split("/").some((part) => part === ".." || part === "")
      ) {
        throw new Error(`${manifest.id}: invalid opal_note_build.copy entry`);
      }
      const source = copy.from.startsWith(".")
        ? path.resolve(packageDir, copy.from)
        : path.join(ROOT, "node_modules", copy.from);
      if (!existsSync(source)) {
        throw new Error(`${manifest.id}: copy source ${copy.from} not found`);
      }
      const entries = await readdir(source, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
        const rel = path.relative(source, absolute).split(path.sep).join("/");
        files[`${copy.to}/${rel}`] = await readFile(absolute);
      }
    }

    const json = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) {
      throw new Error(`${manifest.id}: plugin.json exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    files["plugin.json"] = Buffer.from(json);

    const bytes = Object.values(files).reduce(
      (total, content) => total + content.length,
      0,
    );
    if (bytes > MAX_VIEWER_BYTES) {
      throw new Error(
        `${manifest.id}: viewer bundle is ${bytes} bytes; maximum is ${MAX_VIEWER_BYTES}`,
      );
    }
    return { id: manifest.id, files };
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
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

  if (kind === "client") {
    const { script, json } = await buildClientPlugin(
      packageDir,
      manifest,
      pkg.opal_note_build ?? {},
    );
    return { id: manifest.id, files: { "plugin.js": script, "plugin.json": json } };
  }

  if (kind === "viewer") {
    return buildViewerPlugin(packageDir, manifest, pkg.opal_note_build ?? {});
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
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
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

async function writeClientIndex(outputRoot, builtClients) {
  await mkdir(outputRoot, { recursive: true });
  const imports = builtClients
    .map(({ built }, index) => `import plugin${index} from "./${built.id}/plugin.js";`)
    .join("\n");
  const names = builtClients.map((_, index) => `plugin${index}`).join(", ");
  await writeFile(
    path.join(outputRoot, "index.js"),
    `${imports}\n\nexport const BUILTIN_CLIENT_PLUGINS = [${names}];\n`,
  );
  await writeFile(
    path.join(outputRoot, "index.d.ts"),
    'import type { BuiltinClientPlugin } from "@app/plugins/types";\n\nexport declare const BUILTIN_CLIENT_PLUGINS: BuiltinClientPlugin[];\n',
  );
}

async function main() {
  const pluginPackages = await discoverPackages(PLUGIN_SOURCE, "plugin");
  const backgroundPackages = await discoverPackages(
    BACKGROUND_SOURCE,
    "background",
  );
  const serverPackages = [];
  const clientPackages = [];
  const viewerPackages = [];
  for (const item of pluginPackages) {
    const pkg = await readPackage(item.dir);
    if (pkg.opal_note?.type === "client") clientPackages.push(item);
    else if (pkg.opal_note?.type === "viewer") viewerPackages.push(item);
    else serverPackages.push(item);
  }
  if (
    pluginPackages.length === 0 &&
    backgroundPackages.length === 0
  ) {
    fail("no builtin packages found under builtin/src");
  }

  const selectedPlugins = only
    ? serverPackages.filter(({ dir }) => {
        const id = path.relative(PLUGIN_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : serverPackages;
  const selectedBackgrounds = only
    ? backgroundPackages.filter(({ dir }) => {
        const id = path.relative(BACKGROUND_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : backgroundPackages;
  const selectedClients = only
    ? clientPackages.filter(({ dir }) => {
        const id = path.relative(PLUGIN_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : clientPackages;

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
  const builtClients = [];
  for (const { dir } of selectedClients) {
    const built = await buildOne("client", dir, PLUGIN_OUTPUT);
    builtClients.push({ dir, built });
  }
  const selectedViewers = only
    ? viewerPackages.filter(({ dir }) => {
        const id = path.relative(PLUGIN_SOURCE, dir).split(path.sep).join("/");
        return id === only;
      })
    : viewerPackages;
  const builtViewers = [];
  for (const { dir } of selectedViewers) {
    const built = await buildOne("viewer", dir, PLUGIN_OUTPUT);
    builtViewers.push({ dir, built });
  }
  const clientIndexEntries = only
    ? clientPackages.map(({ dir }) => ({
        built: {
          id: path.relative(PLUGIN_SOURCE, dir).split(path.sep).join("/"),
        },
      }))
    : builtClients;

  if (check) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "opalnote-builtins-"));
    const tempPlugins = path.join(temp, "plugins");
    const tempBackgrounds = path.join(temp, "backgrounds");
    try {
      for (const { built } of builtPlugins) await writePlugin(tempPlugins, built);
      for (const { dir, built } of builtBackgrounds) {
        await writeBackground(tempBackgrounds, dir, built);
      }
      for (const { built } of builtClients) await writePlugin(tempPlugins, built);
      for (const { built } of builtViewers) await writePlugin(tempPlugins, built);
      await writeClientIndex(tempPlugins, clientIndexEntries);
      const errors = [
        ...(await compareTree(tempPlugins, PLUGIN_OUTPUT)),
        ...(await compareTree(tempBackgrounds, BACKGROUND_OUTPUT)),
      ];
      if (errors.length > 0) {
        fail(`generated built-ins are out of date:\n  ${errors.join("\n  ")}`);
      }
      console.log(
        `  ${builtPlugins.length} plugin(s), ${builtBackgrounds.length} background(s), ${builtClients.length} client plugin(s) and ${builtViewers.length} viewer plugin(s) are up to date`,
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
  for (const { built } of builtClients) {
    await writePlugin(PLUGIN_OUTPUT, built);
  }
  for (const { built } of builtViewers) {
    await writePlugin(PLUGIN_OUTPUT, built);
  }
  await writeClientIndex(PLUGIN_OUTPUT, clientIndexEntries);

  console.log(
    `  wrote ${builtPlugins.length} plugin(s), ${builtBackgrounds.length} background(s), ${builtClients.length} client plugin(s) and ${builtViewers.length} viewer plugin(s)`,
  );
}

step(`Building built-ins${check ? " (check only)" : ""}`);
try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
