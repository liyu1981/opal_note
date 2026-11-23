//! Markdown derivation for the file-first store: the adapter from the shared
//! `lutez` AST to blocks, tasks, tags and links (`mod lutez_ast`), plus the
//! frontmatter split, tag normalisation, summaries and block hashing. Nothing
//! here touches the filesystem or the database.

/// Lowercase + collapse whitespace. Used as the join key between a
/// `[[wikilink]]` and a note title, so renames keep backlinks working.
pub fn normalize_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Normalize a link target, which may be a title (`Roadmap`) or a path
/// (`Journal/2023-03-29` / `pages/hello.md`).
///
/// Legacy Logseq folder prefixes are folded onto the canonical lowercase
/// layout so imported graphs resolve.
pub fn normalize_link_target(target: &str) -> String {
    let mut text = target.trim().trim_start_matches("./").to_lowercase();
    text = text.trim_start_matches('/').to_string();
    if let Some(stripped) = text.strip_suffix(".md") {
        text = stripped.to_string();
    }
    for (from, to) in [
        ("journal/", "journals/"),
        ("journals/", "journals/"),
        ("pages/", "pages/"),
    ] {
        if let Some(rest) = text.strip_prefix(from) {
            text = format!("{to}{rest}");
            break;
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keys a note can be discovered by: its title and its path without `.md`.
pub fn note_link_keys(title: &str, path: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let title_key = normalize_title(title);
    if !title_key.is_empty() {
        keys.push(title_key);
    }
    let path_key = normalize_link_target(path);
    if !path_key.is_empty() && !keys.contains(&path_key) {
        keys.push(path_key);
    }
    keys
}

/// The fence marker a line opens with, if any.
///
/// A fenced block is often written as a child of a list item (`- ``` … ``` ` or
/// `1. ``` … ``` `), which the live editor renders as code. Recognising only a
/// fence at the very start of the line made the *closing* fence open a block
/// instead, swallowing every tag, link and task that followed it.
fn fence_marker(line: &str) -> Option<&'static str> {
    let candidate = strip_list_marker(line).unwrap_or(line);
    if candidate.starts_with("```") {
        Some("```")
    } else if candidate.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// Remove fenced and inline code before scanning for links/tags, so examples
/// do not create phantom notes or tags.
fn strip_fenced_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut fence: Option<&str> = None;
    for line in content.lines() {
        let trimmed = line.trim_start();
        match fence {
            Some(marker) => {
                if trimmed.starts_with(marker) {
                    fence = None;
                }
            }
            None => match fence_marker(trimmed) {
                Some(marker) => fence = Some(marker),
                None => {
                    out.push_str(line);
                    out.push('\n');
                }
            },
        }
    }
    out
}

/// One block of a note body: a line range plus what it is.
///
/// `kind` is one of `paragraph`, `heading`, `list_item`, `task`, `code`, `quote`,
/// `table`, `hr`, `math`, `html`. `depth` is the outline nesting for list items
/// and the heading level (1-6) for headings; `parent_seq` points at the nearest
/// enclosing list item (0 for top-level blocks).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBlock {
    pub start_line: usize,
    pub end_line: usize,
    pub kind: String,
    pub depth: usize,
    pub parent_seq: usize,
    pub text: String,
    pub hash: String,
}

const MAX_BLOCK_TEXT_CHARS: usize = 4_000;

fn block(
    start: usize,
    end: usize,
    kind: &str,
    depth: usize,
    parent_seq: usize,
    text: String,
) -> ParsedBlock {
    ParsedBlock {
        start_line: start + 1,
        end_line: end + 1,
        kind: kind.to_string(),
        depth,
        parent_seq,
        hash: block_hash(&text),
        text,
    }
}

/// Plain text of a block: block markers removed, inline markup kept, capped.
fn block_text(lines: &[&str], kind: &str) -> String {
    let mut text = String::new();
    for line in lines {
        let mut value = line.trim_start();
        if kind == "quote" {
            value = value.strip_prefix('>').unwrap_or(value).trim_start();
        } else if kind == "list_item" || kind == "task" {
            if let Some(rest) = strip_list_marker(value) {
                value = rest;
            }
            if kind == "task" {
                value = strip_task_marker(value);
            }
        } else if kind == "heading" {
            value = value.trim_start_matches('#').trim_start();
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(value.trim_end());
    }
    text.truncate(MAX_BLOCK_TEXT_CHARS);
    text
}

/// Drop a checkbox or Logseq keyword from a task's text.
fn strip_task_marker(value: &str) -> &str {
    for checkbox in ["[ ]", "[x]", "[X]", "[-]"] {
        if let Some(rest) = value.strip_prefix(checkbox) {
            return rest.trim_start();
        }
    }
    for keyword in ["TODO", "DOING", "DONE", "CANCELED", "CANCELLED"] {
        if let Some(rest) = value.strip_prefix(keyword) {
            if rest.chars().next().is_some_and(char::is_whitespace) {
                return rest.trim_start();
            }
        }
    }
    value
}

/// Short, stable digest of block text: FNV-1a over a normalised string.
///
/// The client implements the same function, so a deep link can be built without
/// asking the server. It only has to recognise the same block, not resist
/// tampering.
pub fn block_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', ',', ';', ':', '!', '?'])
        .as_bytes()
    {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn heading_level(trimmed: &str) -> Option<usize> {
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    trimmed
        .chars()
        .nth(hashes)
        .is_some_and(char::is_whitespace)
        .then_some(hashes)
}

/// Strip a `-`, `*`, `+` or `1.`/`1)` marker and its trailing whitespace.
fn strip_list_marker(trimmed: &str) -> Option<&str> {
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    let rest = chars.as_str();
    if matches!(first, '-' | '*' | '+') {
        if rest.chars().next().is_some_and(char::is_whitespace) {
            return Some(rest.trim_start());
        }
        return None;
    }
    if !first.is_ascii_digit() {
        return None;
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    let after = &trimmed[digits..];
    let mut after_chars = after.chars();
    let delimiter = after_chars.next()?;
    if !matches!(delimiter, '.' | ')') {
        return None;
    }
    let remainder = after_chars.as_str();
    if !remainder.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    Some(remainder.trim_start())
}

/// A task/checkbox extracted from a note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTask {
    /// 1-based line number within the body.
    pub line: usize,
    pub text: String,
    pub status: String,
}

/// Strip a `-`, `*` or `+` bullet and the whitespace that follows it.
fn strip_bullet(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    if !matches!(chars.next()?, '-' | '*' | '+') {
        return None;
    }
    let rest = chars.as_str();
    if !rest.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    Some(rest.trim_start())
}

fn keyword_task<'a>(
    rest: &'a str,
    keyword: &str,
    status: &'static str,
) -> Option<(&'static str, &'a str)> {
    let after = rest.strip_prefix(keyword)?;
    if after.is_empty() || after.starts_with(char::is_whitespace) {
        Some((status, after.trim_start()))
    } else {
        None
    }
}

/// Turn a raw `[[…]]` payload into a `(normalized target, label)` pair.
///
/// `[[Note#Heading]]` links to `Note` and keeps the heading in the label;
/// `[[Note|alias]]` keeps the alias. Both parsers share this so a link target
/// cannot drift between the AST adapter and the legacy scanner.
fn wikilink_entry(inner: &str) -> Option<(String, String)> {
    // `[[Label] Markdown](url)` is a markdown link, not a wikilink: the parser
    // hands us the raw payload, and a single bracket inside means the author
    // closed the brackets himself.
    if inner.contains(['[', ']']) {
        return None;
    }
    let (raw_target, label) = match inner.split_once('|') {
        Some((target, label)) => (target, label.trim()),
        None => (inner, inner.trim()),
    };
    let target_text = raw_target.split('#').next().unwrap_or(raw_target).trim();
    let target = normalize_link_target(target_text);
    if target.is_empty() {
        return None;
    }
    let label = if label.is_empty() { target_text } else { label };
    Some((target, label.to_string()))
}

/// Add a link, deduplicated by target (the first label wins).
fn push_wikilink(found: &mut Vec<(String, String)>, inner: &str) {
    let Some((target, label)) = wikilink_entry(inner) else {
        return;
    };
    if !found.iter().any(|(existing, _)| existing == &target) {
        found.push((target, label));
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.')
}

/// Normalize a tag coming from an API request or from `#inline` syntax.
pub fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.trim().trim_start_matches('#').trim();
    let tag = tag
        .chars()
        .filter(|c| is_tag_char(*c))
        .collect::<String>()
        .trim_matches(['.', '/'])
        .to_lowercase();
    if tag.is_empty() || tag.chars().count() > 64 {
        None
    } else {
        Some(tag)
    }
}

/// Merge an already-extracted inline tag list with explicit frontmatter tags.
pub fn merge_tag_lists(inline: &[String], explicit: &[String]) -> Vec<String> {
    let mut tags = Vec::new();
    for tag in explicit {
        if let Some(tag) = normalize_tag(tag) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    for tag in inline {
        if !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    tags
}

// ---------------------------------------------------------------------------
// Parser dispatch: the shared `lutez` AST, with the hand-written scanners as a
// fallback
// ---------------------------------------------------------------------------

/// Everything one pass over a note body produces for the index.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedContent {
    pub blocks: Vec<ParsedBlock>,
    pub tasks: Vec<ParsedTask>,
    pub tags: Vec<String>,
    pub links: Vec<(String, String)>,
}

/// Parse a note body once, producing every derived index row.
///
/// The parse is the shared `lutez` AST (see `doc/lutez-parser.md`). There is no
/// second implementation to fall back to: a body the parser refuses is logged
/// and indexes as empty rather than being read by a different grammar.
pub fn parse_content(body: &str) -> ParsedContent {
    match lutez_ast::parse(body) {
        Some(content) => content,
        None => {
            tracing::error!("lutez could not parse a note body; indexing it as empty");
            ParsedContent::default()
        }
    }
}

/// Blocks for a body. Tests and the parity harness read the fields of a single
/// [`parse_content`] pass; the store itself only calls `parse_content`.
#[cfg(test)]
pub fn parse_blocks(body: &str) -> Vec<ParsedBlock> {
    parse_content(body).blocks
}

/// Tasks for a body, as [`parse_blocks`].
#[cfg(test)]
pub fn extract_tasks(content: &str) -> Vec<ParsedTask> {
    parse_content(content).tasks
}

/// Inline `#tags` for a body, as [`parse_blocks`].
#[cfg(test)]
pub fn extract_tags(content: &str) -> Vec<String> {
    parse_content(content).tags
}

/// `[[wikilinks]]` for a body, as [`parse_blocks`].
#[cfg(test)]
pub fn extract_wikilinks(content: &str) -> Vec<(String, String)> {
    parse_content(content).links
}

/// Merge explicit (frontmatter) tags with the body's inline `#tags`.
pub fn merge_tags(body: &str, explicit: &[String]) -> Vec<String> {
    merge_tag_lists(&parse_content(body).tags, explicit)
}

/// Build a compact plain-text summary for list and search results.
pub fn summarize(content: &str, limit: usize) -> String {
    let mut out = String::with_capacity(limit);
    for line in strip_fenced_code(content).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cleaned = line
            .trim_start_matches(['#', '>', '-', '*', '+', ' '])
            .replace(['*', '_', '`'], "");
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&cleaned);
        if out.chars().count() >= limit {
            break;
        }
    }
    if out.chars().count() > limit {
        let mut truncated: String = out.chars().take(limit).collect();
        truncated = truncated.trim_end().to_string();
        truncated.push('…');
        truncated
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/// Split optional YAML frontmatter from the markdown body.
///
/// Only a leading `---` block terminated by a `---` line is considered; an
/// unterminated block is treated as ordinary content.
pub fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;

    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        if content == "---" {
            let frontmatter = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((frontmatter, body));
        }
        offset += line.len();
    }
    None
}

/// A parsed page: body without frontmatter, plus canonical explicit tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPage {
    pub body: String,
    pub frontmatter: Option<String>,
    pub tags: Vec<String>,
}

pub fn parse_page(raw: &str) -> ParsedPage {
    match split_frontmatter(raw) {
        Some((frontmatter, body)) => ParsedPage {
            body: body.to_string(),
            frontmatter: Some(frontmatter.to_string()),
            tags: frontmatter_tags(frontmatter),
        },
        None => ParsedPage {
            body: raw.strip_prefix('\u{feff}').unwrap_or(raw).to_string(),
            frontmatter: None,
            tags: Vec::new(),
        },
    }
}

fn tag_key_value(line: &str) -> Option<&str> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    for key in ["tags:", "tag:"] {
        if let Some(value) = line.strip_prefix(key) {
            return Some(value.trim());
        }
    }
    None
}

fn is_block_list_item(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let item = trimmed.strip_prefix("- ")?;
    Some(item.trim())
}

fn unquote(value: &str) -> &str {
    value.trim().trim_matches('"').trim_matches('\'').trim()
}

fn push_inline_tags(value: &str, tags: &mut Vec<String>) {
    let value = value.trim();
    let value = value
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(value);
    for part in value.split(',') {
        let part = unquote(part);
        if let Some(tag) = normalize_tag(part) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
}

/// End index (exclusive) of a `tags:` value block, starting at the key line.
fn tag_block_end(lines: &[&str], key_index: usize) -> usize {
    let value = tag_key_value(lines[key_index]).unwrap_or("");
    if !value.is_empty() {
        return key_index + 1;
    }

    let mut index = key_index + 1;
    while index < lines.len() {
        if is_block_list_item(lines[index]).is_some() {
            index += 1;
        } else if lines[index].trim().is_empty() {
            // Keep a blank line only when the list continues after it.
            let mut next = index + 1;
            while next < lines.len() && lines[next].trim().is_empty() {
                next += 1;
            }
            if next < lines.len() && is_block_list_item(lines[next]).is_some() {
                index = next;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    index
}

/// Tags declared in YAML frontmatter. Supports:
///
/// ```yaml
/// tags:
/// - one
/// - two
/// ```
/// and `tags: [one, two]` / `tags: one, two`.
pub fn frontmatter_tags(frontmatter: &str) -> Vec<String> {
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut tags = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let Some(value) = tag_key_value(lines[index]) else {
            index += 1;
            continue;
        };

        if value.is_empty() {
            let end = tag_block_end(&lines, index);
            for line in &lines[index + 1..end] {
                if let Some(item) = is_block_list_item(line) {
                    let item = unquote(item);
                    if let Some(tag) = normalize_tag(item) {
                        if !tags.contains(&tag) {
                            tags.push(tag);
                        }
                    }
                }
            }
            index = end;
        } else {
            push_inline_tags(value, &mut tags);
            index += 1;
        }
    }
    tags
}

/// Remove a `tags:`/`tag:` key and its block from frontmatter, preserving all
/// other keys and lines byte-for-byte otherwise.
fn strip_tag_block(frontmatter: &str) -> String {
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        if tag_key_value(lines[index]).is_some() {
            index = tag_block_end(&lines, index);
        } else {
            kept.push(lines[index]);
            index += 1;
        }
    }

    while kept.first().is_some_and(|line| line.trim().is_empty()) {
        kept.remove(0);
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    kept.join("\n")
}

/// Render a file with canonical frontmatter tags and the given body.
///
/// Existing frontmatter keys (e.g. `date`) are preserved; only the tags block
/// is rewritten. An empty tag list removes it, and empty frontmatter is
/// dropped entirely.
pub fn render_page(body: &str, tags: &[String], existing_raw: &str) -> String {
    let existing_frontmatter = split_frontmatter(existing_raw)
        .map(|(frontmatter, _)| frontmatter)
        .unwrap_or("");
    let rest = strip_tag_block(existing_frontmatter);

    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        if let Some(tag) = normalize_tag(tag) {
            if !normalized.contains(&tag) {
                normalized.push(tag);
            }
        }
    }

    let mut frontmatter = String::new();
    if !normalized.is_empty() {
        frontmatter.push_str("tags:\n");
        for tag in &normalized {
            frontmatter.push_str("- ");
            frontmatter.push_str(tag);
            frontmatter.push('\n');
        }
    }
    if !rest.trim().is_empty() {
        if !frontmatter.is_empty() && !frontmatter.ends_with('\n') {
            frontmatter.push('\n');
        }
        frontmatter.push_str(&rest);
        frontmatter.push('\n');
    }

    if frontmatter.trim().is_empty() {
        body.to_string()
    } else {
        format!("---\n{frontmatter}---\n{body}")
    }
}

mod lutez_ast {
    //! Adapter from the shared `lutez` AST to OpalNote's derived rows.
    //!
    //! The AST supplies **structure** (which lines are a block, of which kind,
    //! and how items nest); the raw source lines still supply the *text* of a
    //! block, so `block_text`/`block_hash` stay byte-identical to the legacy
    //! scanner for every block whose range and kind are unchanged.
    //!
    //! Block grammar (see `doc/blocks.md` §1): one block per list item, plus one
    //! per top-level paragraph / heading / fenced code / quote / table / break /
    //! HTML block / `$$` math block. A block-level node *inside* a list item
    //! belongs to that item, except a fence written as the item's content
    //! (`- ``` … ``` `), which becomes the item's `code` block.

    use super::*;
    use crate::store::lutez::{self, Ast};

    /// Parse `body` through lutez. `None` means the library refused the input;
    /// the caller then indexes the note with no derived rows.
    pub(super) fn parse(body: &str) -> Option<ParsedContent> {
        let document = lutez::Document::parse(body)?;
        let ast = document.ast()?;
        let mut builder = Builder::new(body);
        builder.collect_inline(&ast);
        builder.walk(&ast, 0, 0, 0);
        Some(builder.content)
    }

    struct Builder<'a> {
        body: &'a str,
        lines: Vec<&'a str>,
        line_starts: Vec<usize>,
        content: ParsedContent,
    }

    impl<'a> Builder<'a> {
        fn new(body: &'a str) -> Self {
            let mut line_starts = vec![0usize];
            for (index, byte) in body.bytes().enumerate() {
                if byte == b'\n' {
                    line_starts.push(index + 1);
                }
            }
            Self {
                body,
                lines: body.lines().collect(),
                line_starts,
                content: ParsedContent::default(),
            }
        }

        /// 1-based line number of a raw byte offset.
        fn line_of(&self, offset: u32) -> usize {
            let offset = (offset as usize).min(self.body.len());
            match self.line_starts.binary_search(&offset) {
                Ok(index) => index + 1,
                Err(index) => index.max(1),
            }
        }

        /// 1-based line the node's last source byte sits on.
        fn end_line(&self, node: &lutez::Node) -> usize {
            if node.raw_end > node.raw_start {
                self.line_of(node.raw_end - 1)
            } else {
                self.line_of(node.raw_start)
            }
        }

        /// Tags and wikilinks, in document order.
        fn collect_inline(&mut self, ast: &Ast<'_>) {
            let mut tags: Vec<String> = Vec::new();
            let mut links: Vec<(String, String)> = Vec::new();
            ast.walk(|node| {
                if node.kind != lutez::INLINE_EXTENSION {
                    return;
                }
                let token = ast.token(node);
                match node.ext_kind as u32 {
                    lutez::EXT_KIND_TAG => {
                        if let Some(tag) = normalize_tag(token) {
                            if !tags.contains(&tag) {
                                tags.push(tag);
                            }
                        }
                    }
                    lutez::EXT_KIND_WIKILINK => push_wikilink(&mut links, token),
                    _ => {}
                }
            });
            self.content.tags = tags;
            self.content.links = links;
        }

        /// Depth-first block walk. `depth` is the item nesting level; `parent_seq`
        /// is the `seq` of the enclosing list item (0 at the top level).
        fn walk(&mut self, ast: &Ast<'_>, index: u32, depth: usize, parent_seq: usize) {
            let Some(node) = ast.node(index) else { return };
            match node.kind {
                lutez::DOCUMENT | lutez::LIST => {
                    let mut child = node.first_child;
                    while child != lutez::NULL_NODE {
                        self.walk(ast, child, depth, parent_seq);
                        child = ast
                            .node(child)
                            .map(|next| next.next)
                            .unwrap_or(lutez::NULL_NODE);
                    }
                }
                lutez::LIST_ITEM => {
                    let item_line = self.line_of(node.raw_start);
                    let seq = self.push_item(ast, &node, depth, parent_seq);
                    // Nested list items are blocks of their own; so is block-level
                    // content that starts on a continuation line (a fence, quote
                    // or table under an item), because the editor renders it
                    // outside the item's own text.
                    let mut child = node.first_child;
                    while child != lutez::NULL_NODE {
                        if let Some(nested) = ast.node(child) {
                            match nested.kind {
                                lutez::LIST => self.walk(ast, child, depth + 1, seq),
                                _ => self.hoist_child(&nested, item_line),
                            }
                        }
                        child = ast
                            .node(child)
                            .map(|next| next.next)
                            .unwrap_or(lutez::NULL_NODE);
                    }
                }
                _ => self.push_leaf(&node),
            }
        }

        fn push_item(
            &mut self,
            ast: &Ast<'_>,
            node: &lutez::Node,
            depth: usize,
            parent_seq: usize,
        ) -> usize {
            let start = self.line_of(node.raw_start);
            let first_child = ast.node(node.first_child);
            let first_kind = first_child.map(|child| child.kind);

            // A fence written as the item's content (`- ```js`) is a code block
            // covering the item, as the editor renders it.
            if first_kind == Some(lutez::CODE_BLOCK) {
                let end = self.end_line(node);
                return self.push_block(start, end, "code", 0, 0);
            }

            // An item's own range stops after its first paragraph, so nested
            // items (which are their own blocks) never overlap their parent.
            let end = match first_kind {
                // The item's own text: its first paragraph, soft-wrapped lines
                // included.
                Some(lutez::PARAGRAPH) => first_child
                    .map(|paragraph| self.end_line(&paragraph))
                    .unwrap_or(start),
                // A leading quote is hoisted (see `hoist_child`), so the item
                // keeps just its marker line.
                Some(lutez::BLOCKQUOTE) => start,
                // A heading/table/fence that begins on the marker line is the
                // item's content; anything else (nested items, content on the
                // following lines) is not part of the item's own range.
                Some(_) => match first_child {
                    Some(child) if self.line_of(child.raw_start) == start => self.end_line(&child),
                    _ => start,
                },
                None => start,
            };

            // The marker itself is read from the item's first source line: the
            // AST says which lines are items, the line says which of them the
            // editor renders as a checkbox or a Logseq keyword.
            let task = self.lines.get(start - 1).and_then(|line| task_row(line));
            let kind = if task.is_some() { "task" } else { "list_item" };
            let seq = self.push_block(start, end, kind, depth, parent_seq);
            if let Some((status, text)) = task {
                self.content.tasks.push(ParsedTask {
                    line: start,
                    text,
                    status: status.to_string(),
                });
            }
            seq
        }

        /// Emit block-level content that sits *under* an item but is not the
        /// item's own text (a fence, quote or table on a continuation line).
        fn hoist_child(&mut self, node: &lutez::Node, item_line: usize) {
            let start = self.line_of(node.raw_start);
            let end = self.end_line(node);
            match node.kind {
                lutez::BLOCKQUOTE => {
                    if start > item_line {
                        self.push_leaf(node);
                    } else if end > item_line {
                        // `- > quote` followed by more `>` lines: the marker line
                        // belongs to the item, the rest is the quote block.
                        self.push_block(item_line + 1, end, "quote", 0, 0);
                    }
                }
                lutez::CODE_BLOCK
                | lutez::TABLE
                | lutez::HEADING
                | lutez::HTML_BLOCK
                | lutez::THEMATIC_BREAK
                | lutez::BLOCK_EXTENSION
                    if start > item_line =>
                {
                    // `push_leaf` drops extension kinds we do not index (only
                    // `$$` math becomes a block).
                    self.push_leaf(node)
                }
                _ => {}
            }
        }

        fn push_leaf(&mut self, node: &lutez::Node) {
            let start = self.line_of(node.raw_start);
            let end = self.end_line(node);
            let (kind, depth) = match node.kind {
                lutez::PARAGRAPH | lutez::LINK_REF_DEF_BLOCK => ("paragraph", 0),
                lutez::HEADING => (
                    "heading",
                    self.lines
                        .get(start - 1)
                        .and_then(|line| heading_level(line.trim_start()))
                        .unwrap_or(1),
                ),
                lutez::CODE_BLOCK => ("code", 0),
                lutez::BLOCKQUOTE => ("quote", 0),
                lutez::TABLE => ("table", 0),
                lutez::THEMATIC_BREAK => ("hr", 0),
                lutez::HTML_BLOCK => ("html", 0),
                lutez::BLOCK_EXTENSION if node.ext_kind == lutez::EXT_KIND_MATH as i32 => {
                    ("math", 0)
                }
                _ => return,
            };
            self.push_block(start, end, kind, depth, 0);
        }

        /// Push one block built from its raw line range, returning its `seq`.
        fn push_block(
            &mut self,
            start: usize,
            end: usize,
            kind: &str,
            depth: usize,
            parent_seq: usize,
        ) -> usize {
            let last = self.lines.len().max(1);
            let start = start.clamp(1, last);
            let end = end.clamp(start, last);
            // A thematic break carries no text (the legacy scanner leaves it
            // empty, and the client renders the marker itself).
            let text = if kind == "hr" {
                String::new()
            } else {
                block_text(&self.lines[start - 1..end], kind)
            };
            self.content
                .blocks
                .push(block(start - 1, end - 1, kind, depth, parent_seq, text));
            self.content.blocks.len()
        }
    }

    /// A task on one list-item line: checkbox or Logseq keyword, mirroring
    /// `extract_tasks`. Empty task text is not a task.
    fn task_row(line: &str) -> Option<(&'static str, String)> {
        let rest = strip_bullet(line.trim_start())?;
        let (status, text): (&'static str, &str) = if let Some(text) = rest.strip_prefix("[ ]") {
            ("open", text)
        } else if let Some(text) = rest
            .strip_prefix("[x]")
            .or_else(|| rest.strip_prefix("[X]"))
        {
            ("done", text)
        } else if let Some(text) = rest.strip_prefix("[-]") {
            ("cancelled", text)
        } else {
            keyword_task(rest, "TODO", "open")
                .or_else(|| keyword_task(rest, "DOING", "doing"))
                .or_else(|| keyword_task(rest, "DONE", "done"))
                .or_else(|| keyword_task(rest, "CANCELED", "cancelled"))
                .or_else(|| keyword_task(rest, "CANCELLED", "cancelled"))?
        };
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        Some((status, text.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn normalizes_titles() {
        assert_eq!(normalize_title("  Hello   World "), "hello world");
    }

    #[test]
    fn normalizes_link_targets_and_legacy_dirs() {
        assert_eq!(
            normalize_link_target("Journal/2023-03-29.md"),
            "journals/2023-03-29"
        );
        assert_eq!(
            normalize_link_target("./Pages/Hello World"),
            "pages/hello world"
        );
        assert_eq!(normalize_link_target("Plain Title"), "plain title");
    }

    #[test]
    fn note_link_keys_include_title_and_path() {
        let keys = note_link_keys("2023-03-29", "journals/2023-03-29.md");
        assert_eq!(keys, vec!["2023-03-29", "journals/2023-03-29"]);
    }

    #[test]
    fn finds_wikilinks_with_labels_and_headings() {
        let links = extract_wikilinks(
            "See [[Alpha]], [[Beta|the beta]] and [[Gamma#Part 2]].\n\
             Ignored: `[[NotALink]]`.\n\
             ```\n[[CodeLink]]\n```\n\
             [[Journal/2023-03-29]]",
        );
        assert_eq!(links.len(), 4);
        assert_eq!(links[0], ("alpha".into(), "Alpha".into()));
        assert_eq!(links[1], ("beta".into(), "the beta".into()));
        assert_eq!(links[2], ("gamma".into(), "Gamma#Part 2".into()));
        assert_eq!(
            links[3],
            ("journals/2023-03-29".into(), "Journal/2023-03-29".into())
        );
    }

    #[test]
    fn ignores_malformed_bracket_sequences() {
        let links = extract_wikilinks(
            "- [[Data Science] Web Match Rates One Pager](https://example.com) #tag\n[[Real]]",
        );
        assert_eq!(links, vec![("real".into(), "Real".into())]);
    }

    #[test]
    fn deduplicates_links() {
        let links = extract_wikilinks("[[A]] [[a|again]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].1, "A");
    }

    #[test]
    fn extracts_inline_tags() {
        let tags = extract_tags("# Heading\nA #rust note, #datalog and C#.\n#rust again.");
        assert_eq!(tags, vec!["rust", "datalog"]);
    }

    #[test]
    fn ignores_tags_in_code_fences() {
        let tags = extract_tags("text #real\n```sh\n#notatag\n```");
        assert_eq!(tags, vec!["real"]);
    }

    /// A fence written as a list child (`- ``` … ``` `) must not leave the
    /// closing fence to open a block: that swallowed the rest of the note and
    /// hid every later tag (a deployed journal entry showed no tagged block).
    #[test]
    fn ignores_tags_in_a_code_fence_inside_a_bullet() {
        let content = "- intro #before\n  - ```\n    body #incode\n    ```\n- later #after\n";
        let tags = extract_tags(content);
        assert_eq!(tags, vec!["before", "after"]);
    }

    /// Fences may also open behind an ordered marker (`1. ``` `), which the
    /// live editor renders as code; the indexers must agree.
    #[test]
    fn ignores_tags_in_a_code_fence_inside_an_ordered_item() {
        let content = "first #before\n1. ```sh\n   #notatag\n   ```\nlast #after\n";
        let tags = extract_tags(content);
        assert_eq!(tags, vec!["before", "after"]);
    }

    #[test]
    fn fenced_block_inside_an_ordered_item_does_not_hide_later_tasks() {
        let content = "1. ```\n   - [ ] not a task\n   ```\n- [ ] real task\n";
        let tasks = extract_tasks(content);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].text, "real task");
    }

    #[test]
    fn parses_an_ordered_item_fence_as_a_code_block() {
        let blocks = parse_blocks("1. ```js\n   const a = 1;\n   ```\n\ntail\n");
        assert_eq!(blocks[0].kind, "code");
        assert_eq!((blocks[0].start_line, blocks[0].end_line), (1, 3));
        assert_eq!(blocks[1].kind, "paragraph");
    }

    /// Server side of `pnpm check:parse`: print the derived rows for every note
    /// so the script can diff them against the browser's. Ignored by default
    /// (it needs the local data dir); the script runs it with
    /// `OPALNOTE_PARITY_DUMP=1`.
    #[test]
    #[ignore = "needs data/notebooks; run via `pnpm check:parse`"]
    fn corpus_rows() {
        let root = Path::new("data/notebooks");
        if !root.is_dir() {
            eprintln!("no data/notebooks; skipping");
            return;
        }
        let mut files = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                    files.push(path);
                }
            }
        }
        files.sort();
        for path in files {
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let body = parse_page(&raw).body;
            let content = parse_content(&body);
            let blocks: Vec<String> = content
                .blocks
                .iter()
                .map(|block| {
                    format!(
                        "{}@{}-{}#{}>{}",
                        block.kind, block.start_line, block.end_line, block.depth, block.parent_seq
                    )
                })
                .collect();
            let tasks: Vec<String> = content
                .tasks
                .iter()
                .map(|task| format!("{}:{}:{}", task.line, task.status, task.text))
                .collect();
            let links: Vec<String> = content
                .links
                .iter()
                .map(|(target, _)| target.clone())
                .collect();
            println!(
                "{}\t{}\t{}\t{}\t{}",
                path.strip_prefix(root).unwrap_or(&path).display(),
                blocks.join(" "),
                tasks.join(" "),
                content.tags.join(","),
                links.join(",")
            );
        }
    }

    #[test]
    fn merges_and_normalizes_tags() {
        let tags = merge_tags("body #Inline", &["#Explicit".into(), " inline ".into()]);
        assert_eq!(tags, vec!["explicit", "inline"]);
    }

    #[test]
    fn extracts_markdown_and_logseq_tasks() {
        let content = "\n- [ ] open task\n  - [x] done task\n- TODO logseq open\n- DOING in progress\n- DONE finished\n- [-] cancelled\n```\n- [ ] code task\n```\n";
        let tasks = extract_tasks(content);
        let statuses: Vec<&str> = tasks.iter().map(|task| task.status.as_str()).collect();
        assert_eq!(
            statuses,
            vec!["open", "done", "open", "doing", "done", "cancelled"]
        );
        assert_eq!(tasks[0].text, "open task");
        assert_eq!(tasks[0].line, 2);
    }

    /// The live editor renders any whitespace run after a bullet as a task, so
    /// the extractor must accept it too (a mismatch hid tasks from the todo list).
    #[test]
    fn accepts_extra_whitespace_after_the_bullet() {
        let content = "\n-  [ ] two spaces\n-\t[x] tab\n- \t[-] space tab\n*  TODO spaced keyword\n+ [ ] plus\n- plain bullet\n";
        let tasks = extract_tasks(content);
        let rows: Vec<(&str, &str)> = tasks
            .iter()
            .map(|task| (task.status.as_str(), task.text.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("open", "two spaces"),
                ("done", "tab"),
                ("cancelled", "space tab"),
                ("open", "spaced keyword"),
                ("open", "plus"),
            ]
        );
    }

    /// A fenced block written as a list child (`- ``` … ``` `) used to swallow
    /// the rest of the note: the closing fence opened a block instead.
    #[test]
    fn fenced_block_inside_a_bullet_does_not_hide_later_tasks() {
        let content = concat!(
            "- interest learning from dev suwu #suwu #ios #certificate\n",
            "  - ``` \n",
            "    Found the actual reason — it isn't your trust settings.\n",
            "    notBefore = 2026-08-28 12:54:56\n",
            "    #notatag inside the block\n",
            "    ```\n",
            " \n",
            " - [ ] need a refresh button as in pwa mode\n",
            " - [ ] need a way of capture ai conversation to note\n",
            " - [ ] why task added in mobile pwa will not show up?\n",
            "\n",
            "- system design course #system-design #ai-agent\n",
            "  - recording is [here](https://example.com/rec)\n",
            "\n",
            "- [ ] new test item\n",
        );
        let tasks = extract_tasks(content);
        let texts: Vec<&str> = tasks.iter().map(|task| task.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "need a refresh button as in pwa mode",
                "need a way of capture ai conversation to note",
                "why task added in mobile pwa will not show up?",
                "new test item",
            ]
        );
        // Tags and links after the block survive; the one inside it does not.
        assert_eq!(
            extract_tags(content),
            vec!["suwu", "ios", "certificate", "system-design", "ai-agent"]
        );
        let targets: Vec<String> = extract_wikilinks(content)
            .into_iter()
            .map(|(target, _)| target)
            .collect();
        assert!(targets.is_empty(), "no phantom links: {targets:?}");
    }

    #[test]
    fn parses_doc_blocks_with_kinds_and_parents() {
        let body = "# Title\n\nIntro paragraph\nwrapped over two lines.\n\n- parent\n  - child\n- sibling\n\n> quoted\n> lines\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n\n---\n";
        let blocks = parse_blocks(body);
        let rows: Vec<(&str, usize, usize, usize, usize)> = blocks
            .iter()
            .map(|b| {
                (
                    b.kind.as_str(),
                    b.start_line,
                    b.end_line,
                    b.depth,
                    b.parent_seq,
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("heading", 1, 1, 1, 0),
                ("paragraph", 3, 4, 0, 0),
                ("list_item", 6, 6, 0, 0),
                ("list_item", 7, 7, 1, 3),
                ("list_item", 8, 8, 0, 0),
                ("quote", 10, 11, 0, 0),
                ("code", 13, 15, 0, 0),
                ("table", 17, 18, 0, 0),
                ("hr", 20, 20, 0, 0),
            ]
        );
        assert_eq!(blocks[1].text, "Intro paragraph\nwrapped over two lines.");
        assert_eq!(blocks[3].text, "child");
        assert_eq!(blocks[5].text, "quoted\nlines");
        assert!(blocks.iter().all(|b| b.hash.len() == 8));
    }

    #[test]
    fn parses_outline_blocks_with_nesting() {
        let body = "- one\n  - two\n    - three\n  - two again\n- four\n";
        let blocks = parse_blocks(body);
        let rows: Vec<(&str, usize, usize, usize, usize)> = blocks
            .iter()
            .map(|b| {
                (
                    b.kind.as_str(),
                    b.start_line,
                    b.end_line,
                    b.depth,
                    b.parent_seq,
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("list_item", 1, 1, 0, 0),
                ("list_item", 2, 2, 1, 1),
                ("list_item", 3, 3, 2, 2),
                ("list_item", 4, 4, 1, 1),
                ("list_item", 5, 5, 0, 0),
            ]
        );
    }

    #[test]
    fn marks_tasks_and_keeps_fenced_blocks_whole() {
        let body = "- [ ] open\n- TODO keyword\n- plain\n\n  - ``` \n    code #notatag\n    ```\n\n- [ ] after the block\n";
        let blocks = parse_blocks(body);
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["task", "task", "list_item", "code", "task"]);
        // The bullet-opened fence is code, and the task after it is its own block.
        assert_eq!(blocks[3].start_line, 5);
        assert_eq!(blocks[3].end_line, 7);
        assert_eq!(blocks[4].text, "after the block");
    }

    #[test]
    fn block_hash_ignores_whitespace_and_trailing_punctuation() {
        assert_eq!(
            block_hash("Some  text\nhere."),
            block_hash("Some text here")
        );
        assert_ne!(block_hash("some text"), block_hash("some other text"));
    }

    /// The shared AST decides the edge cases the old line scanner guessed at.
    /// These assertions pin the grammar; `doc/blocks.md` §1 describes it.
    mod shared_parser {
        use super::*;

        fn rows(body: &str) -> Vec<(String, usize, usize, usize, usize)> {
            lutez_ast::parse(body)
                .expect("lutez parse")
                .blocks
                .iter()
                .map(|b| {
                    (
                        b.kind.clone(),
                        b.start_line,
                        b.end_line,
                        b.depth,
                        b.parent_seq,
                    )
                })
                .collect()
        }

        #[test]
        fn indented_code_is_a_code_block() {
            let rows = rows("intro\n\n    indented code\n    more\n\nafter\n");
            assert_eq!(
                rows,
                vec![
                    ("paragraph".into(), 1, 1, 0, 0),
                    ("code".into(), 3, 4, 0, 0),
                    ("paragraph".into(), 6, 6, 0, 0),
                ]
            );
        }

        /// A bare `-` used to become a paragraph (the line scanner needed
        /// whitespace after the marker); CommonMark makes it an empty item.
        #[test]
        fn empty_bullet_is_a_list_item() {
            let rows = rows("intro\n\n  -\n\noutro\n");
            assert_eq!(
                rows,
                vec![
                    ("paragraph".into(), 1, 1, 0, 0),
                    ("list_item".into(), 3, 3, 0, 0),
                    ("paragraph".into(), 5, 5, 0, 0),
                ]
            );
        }

        #[test]
        fn fence_written_as_item_content_is_the_items_code_block() {
            let rows = rows("- ```js\n  const a = 1;\n  ```\n\ntail\n");
            assert_eq!(
                rows,
                vec![
                    ("code".into(), 1, 3, 0, 0),
                    ("paragraph".into(), 5, 5, 0, 0),
                ]
            );
        }

        #[test]
        fn quote_inside_an_item_splits_from_the_marker_line() {
            let rows = rows("- > quoted\n  > more\n- after\n");
            assert_eq!(
                rows,
                vec![
                    ("list_item".into(), 1, 1, 0, 0),
                    ("quote".into(), 2, 2, 0, 0),
                    ("list_item".into(), 3, 3, 0, 0),
                ]
            );
        }

        /// `parent_seq` is the enclosing item's `seq` on both parsers (the legacy
        /// scanner used to write the parent's start line).
        #[test]
        fn parent_seq_is_the_parents_seq() {
            let body = "# Title\n\n- parent\n  - child\n    - grandchild\n";
            let blocks = parse_blocks(body);
            let rows: Vec<(&str, usize, usize)> = blocks
                .iter()
                .map(|b| (b.kind.as_str(), b.start_line, b.parent_seq))
                .collect();
            // heading is seq 1, so the top item is 2: children point at it.
            assert_eq!(
                rows,
                vec![
                    ("heading", 1, 0),
                    ("list_item", 3, 0),
                    ("list_item", 4, 2),
                    ("list_item", 5, 3),
                ]
            );
        }

        #[test]
        fn nested_ordered_list_after_a_bullet_nests() {
            let rows = rows("- 1) first\n  2) second\n");
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0].0, "list_item");
            assert_eq!(rows[1].4, 1, "the ordered item is a child of the bullet");
        }

        #[test]
        fn tags_follow_the_shared_grammar() {
            // `)` before `#` is a boundary (we used to miss this tag); a dotted
            // and an all-digit tag are not tags.
            let tags = lutez_ast::parse("see (#ok) …/edit)#hg #123 #a.b #tag.\n")
                .expect("lutez parse")
                .tags;
            // `#tag.` is the tag `tag` (the dot terminates the run).
            assert_eq!(tags, vec!["ok", "hg", "a", "tag"]);
        }

        #[test]
        fn reads_math_and_wikilinks() {
            let content = lutez_ast::parse("$x^2$ and [[Page One|alias]]\n").expect("parse");
            assert_eq!(content.links, vec![("page one".into(), "alias".into())]);
            assert_eq!(content.tags, Vec::<String>::new());
        }

        /// The AST says which lines are list items, the source line says which of
        /// them are tasks.
        #[test]
        fn extracts_the_expected_tasks() {
            let content = concat!(
                "- [ ] open\n",
                "  - [x] done\n",
                "- TODO keyword\n",
                "- DOING wip\n",
                "- DONE finished\n",
                "- CANCELED nope\n",
                "- plain\n",
                "1. TODO not a bullet\n",
                "- ```\n",
                "  - [ ] inside code\n",
                "  ```\n",
            );
            let shared = lutez_ast::parse(content).expect("lutez parse").tasks;
            let rows: Vec<(&str, &str)> = shared
                .iter()
                .map(|task| (task.status.as_str(), task.text.as_str()))
                .collect();
            // open, done, TODO, DOING, DONE, CANCELED; the ordered item and the
            // fenced one are not tasks.
            assert_eq!(
                rows,
                vec![
                    ("open", "open"),
                    ("done", "done"),
                    ("open", "keyword"),
                    ("doing", "wip"),
                    ("done", "finished"),
                    ("cancelled", "nope"),
                ]
            );
        }

        /// Tags follow the shared grammar and never come from code.
        #[test]
        fn tags_ignore_code_and_hash_sequences() {
            let content = "A #rust note, #datalog and C#.\n```\n#notatag\n```\n\n#after\n";
            assert_eq!(
                lutez_ast::parse(content).expect("parse").tags,
                vec!["rust", "datalog", "after"]
            );
        }
    }

    #[test]
    fn summarizes_markdown() {
        assert_eq!(
            summarize("# Title\n\nSome **bold** text and `code`.", 80),
            "Title Some bold text and code."
        );
        assert!(summarize(&"word ".repeat(100), 10).ends_with('…'));
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let raw = "---\ntags:\n- journal\ndate: \"2023-05-26\"\n---\n- entry #tiktok\n";
        let parsed = parse_page(raw);
        assert_eq!(parsed.tags, vec!["journal"]);
        assert_eq!(parsed.body, "- entry #tiktok\n");
        assert!(parsed.frontmatter.unwrap().contains("date:"));
    }

    #[test]
    fn parses_inline_frontmatter_tags() {
        assert_eq!(
            frontmatter_tags("tags: [One, \"#two\"]\ndate: today"),
            vec!["one", "two"]
        );
        assert_eq!(frontmatter_tags("tags: one, two"), vec!["one", "two"]);
    }

    #[test]
    fn writes_tags_and_preserves_other_frontmatter() {
        let existing = "---\ntags:\n- old\ndate: \"2023-05-26\"\n---\nbody\n";
        let rendered = render_page("body\n", &["new".into(), "second".into()], existing);
        assert_eq!(
            rendered,
            "---\ntags:\n- new\n- second\ndate: \"2023-05-26\"\n---\nbody\n"
        );
    }

    #[test]
    fn removes_empty_frontmatter() {
        assert_eq!(
            render_page("body", &[], "---\ntags:\n- old\n---\nbody"),
            "body"
        );
        assert_eq!(
            render_page("body", &[], "---\ntags: old\ndate: x\n---\nbody"),
            "---\ndate: x\n---\nbody"
        );
    }

    #[test]
    fn creates_frontmatter_only_when_needed() {
        assert_eq!(render_page("body", &[], "body"), "body");
        assert_eq!(
            render_page("body", &["tag".into()], ""),
            "---\ntags:\n- tag\n---\nbody"
        );
    }
}
