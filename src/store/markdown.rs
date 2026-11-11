//! Pure helpers for the derived index: wikilinks, inline tags, summaries.
//!
//! Nothing here touches the database, so it is cheap to unit test.

/// Lowercase + collapse whitespace. Used as the join key between a
/// `[[wikilink]]` and a note title, so renames keep backlinks working.
pub fn normalize_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Remove fenced code blocks before scanning for links/tags, so code samples
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

/// Also drop inline code spans so `[[example]]` in prose code samples is not
/// indexed as a real link.
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
    let mut rest = stripped.as_str();

    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        rest = &after[end + 2..];

        let (raw_target, label) = match inner.split_once('|') {
            Some((target, label)) => (target, label.trim()),
            None => (inner, inner.trim()),
        };
        // `[[Note#Heading]]` links to `Note`; keep the heading only in the label.
        let target_text = raw_target.split('#').next().unwrap_or(raw_target).trim();
        let target = normalize_title(target_text);
        if target.is_empty() {
            continue;
        }
        let label = if label.is_empty() { target_text } else { label };
        if !found.iter().any(|(t, _)| t == &target) {
            found.push((target, label.to_string()));
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

/// Merge explicit tags with inline `#tags`, preserving first-seen order.
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
        if line.is_empty() || line.starts_with("```") {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_titles() {
        assert_eq!(normalize_title("  Hello   World "), "hello world");
    }

    #[test]
    fn finds_wikilinks_with_labels_and_headings() {
        let links = extract_wikilinks(
            "See [[Alpha]], [[Beta|the beta]] and [[Gamma#Part 2]].\n\
             Ignored: `[[NotALink]]`.\n\
             ```\n[[CodeLink]]\n```",
        );
        assert_eq!(links.len(), 3);
        assert_eq!(links[0], ("alpha".into(), "Alpha".into()));
        assert_eq!(links[1], ("beta".into(), "the beta".into()));
        assert_eq!(links[2], ("gamma".into(), "Gamma#Part 2".into()));
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
}
