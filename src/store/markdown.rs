//! Pure helpers for the file-first store: wikilinks, inline tags, frontmatter
//! tags, summaries. Nothing here touches the filesystem or the database.

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
            None => {
                if trimmed.starts_with("```") {
                    fence = Some("```");
                } else if trimmed.starts_with("~~~") {
                    fence = Some("~~~");
                } else {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    out
}

fn strip_code(content: &str) -> String {
    let fenced = strip_fenced_code(content);
    let mut out = String::with_capacity(fenced.len());
    let mut in_code = false;
    for ch in fenced.chars() {
        if ch == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if in_code {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

/// Extract `[[target]]` / `[[target|label]]` / `[[target#heading]]` links.
///
/// Returns `(normalized_target, label)` pairs, deduplicated by target.
pub fn extract_wikilinks(content: &str) -> Vec<(String, String)> {
    let stripped = strip_code(content);
    let mut found: Vec<(String, String)> = Vec::new();

    // A wikilink always closes on the same line. Scanning line-by-line keeps a
    // stray `[[` in prose (e.g. `[[Label] Markdown](url)`) from swallowing the
    // rest of the document looking for `]]`.
    for line in stripped.lines() {
        let mut rest = line;

        while let Some(start) = rest.find("[[") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("]]") else { break };
            let inner = &after[..end];
            rest = &after[end + 2..];

            if inner.contains(['[', ']']) {
                continue;
            }

            let (raw_target, label) = match inner.split_once('|') {
                Some((target, label)) => (target, label.trim()),
                None => (inner, inner.trim()),
            };
            // `[[Note#Heading]]` links to `Note`; keep the heading only in the label.
            let target_text = raw_target.split('#').next().unwrap_or(raw_target).trim();
            let target = normalize_link_target(target_text);
            if target.is_empty() {
                continue;
            }
            let label = if label.is_empty() { target_text } else { label };
            if !found.iter().any(|(t, _)| t == &target) {
                found.push((target, label.to_string()));
            }
        }
    }
    found
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.')
}

/// Extract `#inline-tags` from prose. Heading markers (`# Title`) and
/// `C#`-style sequences are ignored by requiring whitespace before the `#`
/// and a tag character after it.
pub fn extract_tags(content: &str) -> Vec<String> {
    let stripped = strip_code(content);
    let chars: Vec<char> = stripped.chars().collect();
    let mut tags: Vec<String> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let starts_tag = chars[i] == '#'
            && (i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], '(' | '[' | '{' | ',' | '"' | '\''));
        if !starts_tag {
            i += 1;
            continue;
        }

        let mut j = i + 1;
        while j < chars.len() && is_tag_char(chars[j]) {
            j += 1;
        }

        if j > i + 1 {
            let tag: String = chars[i + 1..j].iter().collect();
            let tag = tag.trim_matches(['.', '/']).to_lowercase();
            if !tag.is_empty() && tag.chars().count() <= 64 && !tags.contains(&tag) {
                tags.push(tag);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    tags
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

/// Merge explicit (frontmatter) tags with inline `#tags`.
pub fn merge_tags(content: &str, explicit: &[String]) -> Vec<String> {
    let mut tags = Vec::new();
    for tag in explicit {
        if let Some(tag) = normalize_tag(tag) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    for tag in extract_tags(content) {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
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

#[cfg(test)]
mod tests {
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

    #[test]
    fn merges_and_normalizes_tags() {
        let tags = merge_tags("body #Inline", &["#Explicit".into(), " inline ".into()]);
        assert_eq!(tags, vec!["explicit", "inline"]);
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
