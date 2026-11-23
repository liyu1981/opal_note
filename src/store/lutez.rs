//! FFI to the vendored `lutez` parser and a reader for its binary AST
//! (`doc/WIRE_FORMAT.md`, wire format 2).
//!
//! `lutez` is a CommonMark 0.31.2 + GFM parser in Zig, linked statically as
//! `liblutez.a` (built by `scripts/build-lutez.mjs`). It replaces the
//! hand-written scanners in [`crate::store::markdown`] so the server indexes the
//! same parse the browser editor gets from `lutez.wasm`.
//!
//! This module does no markdown semantics: it only copies the wire bytes into
//! validated node records. The adapter that turns those records into
//! `ParsedBlock`/`ParsedTask`/tags/links lives in `markdown.rs`.
//!
//! When the static library is missing at build time the module is not compiled
//! (see `build.rs`), and `markdown.rs` keeps using the legacy scanners.
//!
//! Only the node types, extension kinds and preset bits OpalNote reads are
//! named here; `include/lutez.h` is the full vocabulary and the tests below pin
//! the values we depend on.

use std::ffi::c_char;

/// ABI of the C header this module was written against.
pub const ABI_VERSION: u32 = 3;
/// Wire format of the AST bytes.
pub const WIRE_VERSION: u32 = 2;

/// `LUTEZ_EXT_*` bits, matching `include/lutez.h`.
pub const EXT_MATH: u32 = 1 << 1;
pub const EXT_WIKILINKS: u32 = 1 << 2;
pub const EXT_TAGS: u32 = 1 << 3;
pub const EXT_OUTLINER_KEYWORDS: u32 = 1 << 5;

/// The presets OpalNote parses with.
///
/// Frontmatter and outliner blocks stay off: we split frontmatter before
/// parsing and do not use `key::`/`^block-id` (blocks R2).
pub const PRESETS: u32 = EXT_MATH | EXT_WIKILINKS | EXT_TAGS | EXT_OUTLINER_KEYWORDS;

// ---- AST node types -------------------------------------------------------

pub const DOCUMENT: u16 = 0;
pub const PARAGRAPH: u16 = 1;
pub const HEADING: u16 = 2;
pub const THEMATIC_BREAK: u16 = 4;
pub const BLOCKQUOTE: u16 = 5;
pub const LIST: u16 = 7;
pub const LIST_ITEM: u16 = 8;
pub const HTML_BLOCK: u16 = 9;
pub const CODE_BLOCK: u16 = 11;
pub const LINK_REF_DEF_BLOCK: u16 = 45;
pub const TABLE: u16 = 106;
pub const BLOCK_EXTENSION: u16 = 500;
pub const INLINE_EXTENSION: u16 = 501;

/// Extension kinds carried in the ext blob.
pub const EXT_KIND_MATH: u32 = 1;
pub const EXT_KIND_WIKILINK: u32 = 2;
pub const EXT_KIND_TAG: u32 = 3;
/// `TODO`/`DOING` (kind 7). The adapter reads a task's marker from its source
/// line (it needs `DONE`/`CANCELED`, which the preset does not emit); the value
/// is pinned here so an upstream reshuffle fails a test instead of drifting.
#[allow(dead_code)]
pub const EXT_KIND_KEYWORD: u32 = 7;

pub const NULL_NODE: u32 = 0xffff_ffff;

// ---- C ABI ---------------------------------------------------------------

/// Opaque document handle (`lutez_doc`).
#[repr(C)]
struct LutezDoc {
    _private: [u8; 0],
}

/// `lutez_opts` v1: a size field plus twelve `uint8_t` flags.
#[repr(C)]
struct LutezOpts {
    struct_size: u32,
    flags: [u8; 12],
}

// Flag order from `include/lutez.h`: gfm_table, gfm_task_list_item,
// gfm_strikethrough, gfm_strikethrough1, gfm_auto_link, inline_asterisk,
// inline_underscore, setext, indent_code_block, link_ref, data_image, strip_bom.
const OPTS_ON: [u8; 12] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

extern "C" {
    fn lutez_version_string() -> *const c_char;
    fn lutez_abi_version() -> u32;
    fn lutez_wire_format_version() -> u32;
    fn lutez_parse_presets(
        md: *const u8,
        len: usize,
        opts: *const LutezOpts,
        presets: u32,
    ) -> *mut LutezDoc;
    fn lutez_doc_ast(doc: *const LutezDoc, out_len: *mut usize) -> *const u8;
    fn lutez_doc_free(doc: *mut LutezDoc);
    fn lutez_last_error() -> *const c_char;
}

/// True when the linked library reports the ABI and wire format we decode.
pub fn compatible() -> bool {
    // SAFETY: both calls are pure getters with no arguments.
    unsafe { lutez_abi_version() == ABI_VERSION && lutez_wire_format_version() == WIRE_VERSION }
}

/// Library version string, for logs and `/meta`.
pub fn version() -> String {
    // SAFETY: the library owns the string for the process lifetime.
    unsafe {
        let raw = lutez_version_string();
        if raw.is_null() {
            return "unknown".to_string();
        }
        std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned()
    }
}

fn last_error() -> String {
    // SAFETY: thread-local string owned by the library.
    unsafe {
        let raw = lutez_last_error();
        if raw.is_null() {
            return "unknown lutez error".to_string();
        }
        std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned()
    }
}

/// One parsed document. Frees the handle on drop.
pub struct Document {
    handle: *mut LutezDoc,
}

// The document owns a self-contained buffer with no thread affinity: the
// library is reentrant and only the error string is thread-local.
unsafe impl Send for Document {}

impl Document {
    /// Parse `body` with [`PRESETS`]. `None` means the parser refused the input.
    pub fn parse(body: &str) -> Option<Self> {
        let opts = LutezOpts {
            struct_size: std::mem::size_of::<LutezOpts>() as u32,
            flags: OPTS_ON,
        };
        // SAFETY: the buffer pointer and length match, and the library copies
        // the input before returning.
        let handle = unsafe { lutez_parse_presets(body.as_ptr(), body.len(), &opts, PRESETS) };
        if handle.is_null() {
            tracing::warn!(error = %last_error(), "lutez refused a note body");
            return None;
        }
        Some(Self { handle })
    }

    /// Borrow the serialized AST. Valid until the document is dropped.
    pub fn ast(&self) -> Option<Ast<'_>> {
        let mut len = 0usize;
        // SAFETY: `handle` is a live document until `drop`.
        let bytes = unsafe { lutez_doc_ast(self.handle, &mut len) };
        if bytes.is_null() || len < HEADER_LEN {
            return None;
        }
        // SAFETY: the library guarantees `len` readable bytes at `bytes`.
        let bytes = unsafe { std::slice::from_raw_parts(bytes, len) };
        Ast::parse(bytes)
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        // SAFETY: the handle is live exactly once; `drop` runs once.
        unsafe { lutez_doc_free(self.handle) };
    }
}

// ---- wire format 2 -------------------------------------------------------

const HEADER_LEN: usize = 40;
const HEADER_MAGIC: &[u8; 8] = b"LUTEAST1";
const NODE_STRIDE_MIN: usize = 56;

fn align8(value: usize) -> usize {
    (value + 7) & !7
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// One node record from the wire format.
#[derive(Debug, Clone, Copy)]
pub struct Node {
    /// Node type (`DOCUMENT`, `PARAGRAPH`, …).
    pub kind: u16,
    /// Flags: bit 0 = token lives in the pool, bit 8 = span derived.
    pub flags: u16,
    pub first_child: u32,
    pub next: u32,
    tok_ref: u32,
    tok_len: u32,
    /// Half-open **raw byte offsets** into the caller's body.
    pub raw_start: u32,
    pub raw_end: u32,
    /// Extension kind for types 500/501, else -1.
    pub ext_kind: i32,
}

/// A borrowed, validated view of one AST buffer.
pub struct Ast<'a> {
    bytes: &'a [u8],
    nodes_off: usize,
    stride: usize,
    node_count: usize,
    extras_off: usize,
    pool_off: usize,
}

impl<'a> Ast<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.get(0..8)? != HEADER_MAGIC {
            return None;
        }
        if u32_at(bytes, 8)? != WIRE_VERSION {
            return None;
        }
        let node_count = u32_at(bytes, 16)? as usize;
        let stride = u32_at(bytes, 20)? as usize;
        let input_len = u32_at(bytes, 24)? as usize;
        let pool_len = u32_at(bytes, 28)? as usize;
        let ext_len = u32_at(bytes, 32)? as usize;
        let map_len = u32_at(bytes, 36)? as usize;
        if node_count == 0 || stride < NODE_STRIDE_MIN {
            return None;
        }
        let nodes_off = HEADER_LEN;
        let extras_off = align8(nodes_off.checked_add(node_count.checked_mul(stride)?)?);
        let input_off = align8(extras_off.checked_add(ext_len)?);
        let pool_off = align8(input_off.checked_add(input_len)?);
        let map_off = align8(pool_off.checked_add(pool_len)?);
        if map_off.checked_add(map_len)? > bytes.len() {
            return None;
        }
        Some(Self {
            bytes,
            nodes_off,
            stride,
            node_count,
            extras_off,
            pool_off,
        })
    }

    /// The node record at `index`, or `None` when the index is out of range.
    pub fn node(&self, index: u32) -> Option<Node> {
        let index = index as usize;
        if index >= self.node_count {
            return None;
        }
        let base = self.nodes_off + index * self.stride;
        let kind = u16_at(self.bytes, base)?;
        let flags = u16_at(self.bytes, base + 2)?;
        let tok_ref = u32_at(self.bytes, base + 24)?;
        let tok_len = u32_at(self.bytes, base + 28)?;
        let ext_ref = u32_at(self.bytes, base + 48)?;
        let ext_len = u32_at(self.bytes, base + 52)?;
        let ext_kind = if ext_ref == NULL_NODE || ext_len == 0 {
            -1
        } else {
            let offset = self.extras_off + ext_ref as usize;
            u32_at(self.bytes, offset)
                .map(|kind| kind as i32)
                .unwrap_or(-1)
        };
        Some(Node {
            kind,
            flags,
            first_child: u32_at(self.bytes, base + 8)?,
            next: u32_at(self.bytes, base + 20)?,
            tok_ref,
            tok_len,
            raw_start: u32_at(self.bytes, base + 40)?,
            raw_end: u32_at(self.bytes, base + 44)?,
            ext_kind,
        })
    }

    /// Raw token bytes for a node (the source payload the library stored).
    pub fn token(&self, node: &Node) -> &'a str {
        if node.tok_ref == NULL_NODE || node.tok_len == 0 {
            return "";
        }
        if node.flags & 1 == 0 {
            // Wire v2 keeps every token in the pool; the input section is
            // reserved for a future zero-copy mode.
            return "";
        }
        let start = self.pool_off + node.tok_ref as usize;
        let end = start.saturating_add(node.tok_len as usize);
        let Some(bytes) = self.bytes.get(start..end) else {
            return "";
        };
        std::str::from_utf8(bytes).unwrap_or("")
    }

    /// Depth-first walk from the root, in document order.
    pub fn walk(&self, mut visit: impl FnMut(&Node)) {
        // Recursion keeps sibling order; an AST is a few thousand nodes at most.
        fn rec(ast: &Ast<'_>, index: u32, visit: &mut impl FnMut(&Node)) {
            let Some(node) = ast.node(index) else { return };
            visit(&node);
            let mut child = node.first_child;
            while child != NULL_NODE {
                rec(ast, child, visit);
                child = ast.node(child).map(|n| n.next).unwrap_or(NULL_NODE);
            }
        }
        rec(self, 0, &mut visit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_the_abi_and_presets_we_decode() {
        assert!(
            compatible(),
            "liblutez.a must speak ABI {ABI_VERSION} and wire {WIRE_VERSION}"
        );
        // Frontmatter and outliner blocks stay off (see `doc/lutez-parser.md`).
        assert_eq!(
            PRESETS,
            EXT_MATH | EXT_WIKILINKS | EXT_TAGS | EXT_OUTLINER_KEYWORDS
        );
    }

    #[test]
    fn reads_spans_and_extension_nodes() {
        // A Logseq-shaped line exercising every preset that is on.
        let body = "- TODO buy #tag [[Page|alias]] $x$\n";
        let document = Document::parse(body).expect("lutez parse");
        let ast = document.ast().expect("wire ast");

        let root = ast.node(0).expect("document node");
        assert_eq!(root.kind, DOCUMENT);
        assert_eq!((root.raw_start, root.raw_end), (0, body.len() as u32));

        let mut extensions = Vec::new();
        let mut list_items = 0;
        ast.walk(|node| match node.kind {
            LIST_ITEM => list_items += 1,
            INLINE_EXTENSION => {
                extensions.push((node.ext_kind, ast.token(node).to_string()));
                // The span covers the marker: `#tag` starts at its `#`.
                if node.ext_kind == EXT_KIND_TAG as i32 {
                    assert_eq!(
                        &body[node.raw_start as usize..node.raw_end as usize],
                        "#tag"
                    );
                }
            }
            _ => {}
        });
        assert_eq!(list_items, 1);
        assert_eq!(
            extensions,
            vec![
                (EXT_KIND_KEYWORD as i32, "TODO".to_string()),
                (EXT_KIND_TAG as i32, "tag".to_string()),
                (EXT_KIND_WIKILINK as i32, "Page|alias".to_string()),
                (EXT_KIND_MATH as i32, "x".to_string()),
            ]
        );
    }

    #[test]
    fn an_empty_body_is_one_zero_width_node() {
        let document = Document::parse("").expect("lutez parse");
        let ast = document.ast().expect("wire ast");
        let root = ast.node(0).expect("document node");
        assert!(ast.node(1).is_none(), "an empty body is a single node");
        assert_eq!((root.kind, root.raw_start, root.raw_end), (DOCUMENT, 0, 0));
    }
}
