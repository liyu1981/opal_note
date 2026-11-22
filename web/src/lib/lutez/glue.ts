/**
 * Minimal typed wrapper around `lutez.wasm` — the same CommonMark/GFM parser the
 * server links as `liblutez.a` (see `doc/lutez-parser.md`).
 *
 * The module is import-free and exposes a C-style ABI: each parse returns an
 * opaque document handle, `lutez_doc_ast` hands back a packed `(ptr << 32) | len`
 * view of the serialized AST, and the caller frees the handle. We decode the AST
 * immediately and never keep a view across a call that may grow memory.
 */

/** ABI of `include/lutez.h` this wrapper was written against. */
export const LUTEZ_ABI = 3;
/** Wire format of the AST bytes (`doc/WIRE_FORMAT.md`). */
export const LUTEZ_WIRE = 2;

const OPTS_SIZE = 16;
const NULL_HANDLE = 0xffffffff;

/** Preset bits, matching `include/lutez.h`. */
export const PRESET = {
  frontmatter: 1 << 0,
  math: 1 << 1,
  wikilinks: 1 << 2,
  tags: 1 << 3,
  outlinerBlocks: 1 << 4,
  outlinerKeywords: 1 << 5,
} as const;

/**
 * The presets OpalNote parses with — identical to `markdown::lutez::PRESETS`
 * on the server, because both runtimes must derive the same blocks and tasks.
 * Frontmatter is split before parsing; `key::`/`^block-id` stay off until
 * blocks R2.
 */
export const NOTE_PRESETS =
  PRESET.math | PRESET.wikilinks | PRESET.tags | PRESET.outlinerKeywords;

type Exports = {
  memory: WebAssembly.Memory;
  lutez_abi_version(): number;
  lutez_wire_format_version(): number;
  lutez_parse_presets(md: number, len: number, opts: number, presets: number): number;
  lutez_doc_ast(handle: number): bigint;
  lutez_doc_free(handle: number): void;
  lutez_alloc(len: number): number;
  lutez_free(ptr: number, len: number): void;
  lutez_last_error_ptr(): bigint;
};

export type LutezEngine = {
  /** Parse markdown and return a decoder for its AST, then free the document. */
  withAst<T>(markdown: string, read: (ast: Uint8Array) => T): T | null;
};

function createEngine(exports: Exports): LutezEngine {
  const memory = () => new Uint8Array(exports.memory.buffer);
  const decoder = new TextDecoder();

  const lastError = () => {
    const packed = exports.lutez_last_error_ptr();
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    if (!ptr || !len) return "unknown lutez error";
    return decoder.decode(memory().slice(ptr, ptr + len));
  };

  const writeOptions = () => {
    const ptr = exports.lutez_alloc(OPTS_SIZE);
    if (ptr === 0) throw new Error("lutez: out of memory");
    const view = new DataView(exports.memory.buffer, ptr, OPTS_SIZE);
    view.setUint32(0, OPTS_SIZE, true);
    // gfm_table, gfm_task_list_item, gfm_strikethrough, gfm_strikethrough1,
    // gfm_auto_link, inline_asterisk, inline_underscore, setext,
    // indent_code_block, link_ref, data_image, strip_bom — all on, the same
    // flags the server sets in `src/store/lutez.rs`.
    for (let index = 0; index < 12; index += 1) view.setUint8(4 + index, 1);
    return ptr;
  };

  return {
    withAst(markdown, read) {
      const input = new TextEncoder().encode(markdown);
      const inputPtr = input.length === 0 ? 0 : exports.lutez_alloc(input.length);
      if (input.length > 0 && inputPtr === 0) throw new Error("lutez: out of memory");
      if (input.length > 0) memory().set(input, inputPtr);
      const optsPtr = writeOptions();
      let handle = NULL_HANDLE;
      try {
        handle = exports.lutez_parse_presets(
          inputPtr,
          input.length,
          optsPtr,
          NOTE_PRESETS,
        ) >>> 0;
      } finally {
        if (inputPtr) exports.lutez_free(inputPtr, input.length);
        if (optsPtr) exports.lutez_free(optsPtr, OPTS_SIZE);
      }
      if (handle === NULL_HANDLE) {
        console.warn("lutez: parse failed:", lastError());
        return null;
      }
      try {
        const packed = exports.lutez_doc_ast(handle);
        const ptr = Number(packed >> 32n);
        const len = Number(packed & 0xffffffffn);
        if (!ptr || len < 40) return null;
        return read(memory().slice(ptr, ptr + len));
      } finally {
        exports.lutez_doc_free(handle);
      }
    },
  };
}

/** Compile and validate one `lutez.wasm` module. */
export async function createLutezEngine(
  source: BufferSource,
): Promise<LutezEngine> {
  const module = await WebAssembly.compile(source);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(`lutez.wasm must be import-free, found ${imports.length}`);
  }
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as Exports;
  if (exports.lutez_abi_version() !== LUTEZ_ABI) {
    throw new Error(`lutez.wasm has ABI ${exports.lutez_abi_version()}, expected ${LUTEZ_ABI}`);
  }
  if (exports.lutez_wire_format_version() !== LUTEZ_WIRE) {
    throw new Error(
      `lutez.wasm writes wire format ${exports.lutez_wire_format_version()}, expected ${LUTEZ_WIRE}`,
    );
  }
  return createEngine(exports);
}

/**
 * Fetch `/lutez.wasm` (copied from the vendored submodule by
 * `scripts/build-lutez.mjs`) and compile it.
 */
export async function fetchLutezEngine(url = "/lutez.wasm"): Promise<LutezEngine> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`lutez.wasm: HTTP ${response.status}`);
  return createLutezEngine(await response.arrayBuffer());
}
