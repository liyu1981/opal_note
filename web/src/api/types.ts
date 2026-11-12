export interface Notebook {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  note_count: number;
}

export interface NoteSummary {
  /** Relative file path inside the notebook, e.g. `pages/hello.md`. */
  id: string;
  notebook_id: string;
  title: string;
  excerpt: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  score?: number;
}

export interface LinkRef {
  target: string;
  label: string;
  note_id: string | null;
  title: string | null;
}

export interface BacklinkRef {
  id: string;
  title: string;
  updated_at: string;
}

export interface Note {
  /** Relative file path inside the notebook, e.g. `pages/hello.md`. */
  id: string;
  notebook_id: string;
  title: string;
  /** Markdown body with frontmatter removed. */
  content: string;
  created_at: string;
  updated_at: string;
  /** Tags declared in YAML frontmatter (the ones the tag field edits). */
  explicit_tags: string[];
  /** Frontmatter tags plus inline `#tags`. */
  tags: string[];
  links: LinkRef[];
  backlinks: BacklinkRef[];
}

export interface JournalPage {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface Stats {
  notebooks: number;
  notes: number;
  tags: number;
  links: number;
}

export interface Health {
  status: string;
  version: string;
  uptime_secs: number;
  auth_required: boolean;
}

export interface QueryResult {
  headers: string[];
  rows: unknown[][];
  next: unknown;
  took_ms: number;
}
