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

export interface PageOverview {
  /** Relative file path, e.g. `pages/hello.md` or `journals/2026-11-12.md`. */
  id: string;
  notebook_id: string;
  title: string;
  backlink_count: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  /** Empty body with no resolved backlinks. */
  is_orphan: boolean;
}

export interface PageList {
  pages: PageOverview[];
  total: number;
  limit: number;
  offset: number;
}

export interface JournalPluginItem {
  id: string;
  title: string;
  detail: string;
  note_path: string;
  line: number;
  status: string;
  updated_at?: number;
}

export type PluginAction =
  | { type: "openNote"; path: string }
  | { type: "openTag"; tag: string }
  | { type: "openExternal"; url: string }
  | { type: "runCommand"; id: string };

export type PluginUiTone = "muted" | "accent" | "danger" | "success";

export type PluginUiNodeType =
  | "card"
  | "section"
  | "row"
  | "heading"
  | "text"
  | "badge"
  | "list"
  | "button"
  | "link"
  | "separator"
  | "empty"
  | "markdown"
  | "graph";

export interface PluginUiListItem {
  title: string;
  detail?: string;
  note_path?: string;
  status?: string;
  action?: PluginAction;
}

export interface PluginUiNode {
  type: PluginUiNodeType;
  title?: string;
  text?: string;
  label?: string;
  level?: number;
  tone?: PluginUiTone;
  variant?: "default" | "ghost" | "danger";
  emptyText?: string;
  value?: string;
  scope?: "local" | "all";
  includeTags?: boolean;
  height?: number;
  children?: PluginUiNode[];
  items?: PluginUiListItem[];
  action?: PluginAction;
}

export type PluginUi =
  | { schema: 1; root: PluginUiNode }
  | { kind: string; title?: string };

export interface JournalPluginResult {
  id: string;
  title: string;
  description: string;
  items: JournalPluginItem[];
  ui?: PluginUi;
  error?: string;
}

export type PluginSource = "builtin" | "data";

export interface PluginInfo {
  id: string;
  title: string;
  description: string;
  source: PluginSource;
  path?: string;
}

export interface PluginLoadError {
  folder: string;
  message: string;
}

export interface PluginList {
  directory: string;
  plugins: PluginInfo[];
  errors: PluginLoadError[];
}

export interface GraphNode {
  id: string;
  title: string;
  tags: string[];
  /** `note` or `tag`. */
  kind: "note" | "tag";
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

export interface Meta {
  name: string;
  version: string;
  build_commit: string;
  build_time: number;
  build_channel: string;
  api_version: number;
  auth_required: boolean;
  engine: string;
}

export interface QueryResult {
  headers: string[];
  rows: unknown[][];
  next: unknown;
  took_ms: number;
}

export type AssetKind = "image" | "video" | "audio" | "document" | "other";

export interface AssetEntry {
  path: string;
  name: string;
  kind: AssetKind;
  mime: string;
  size: number;
  updated_at: string;
}

export interface AssetReference {
  note_path: string;
  title: string;
  excerpt: string;
}

export interface AssetInfo {
  asset: AssetEntry;
  references: AssetReference[];
}

export interface AssetList {
  assets: AssetEntry[];
  total: number;
  limit: number;
  offset: number;
}

export type TrashKind = "page" | "journal" | "asset" | "notebook";

export interface TrashEntry {
  id: string;
  notebook_id: string;
  notebook_name: string;
  /** Relative path inside the notebook, or the notebook name itself. */
  original_path: string;
  kind: TrashKind;
  title: string;
  size: number;
  deleted_at: string;
  expires_at: string;
  /** Short plain-text summary for note entries. */
  preview: string;
  mime: string;
}

export interface TrashList {
  entries: TrashEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface TrashDetail {
  entry: TrashEntry;
  /** Markdown/body or text-file prefix. `null` for binary payloads. */
  content: string | null;
  truncated: boolean;
}

export interface TrashRestoreResult {
  id: string;
  notebook_id: string;
  notebook_name: string;
  kind: TrashKind;
  /** Path relative to the notebook, or the new notebook id. */
  restored_path: string;
}

export type BackgroundSource = "builtin" | "data";
export type BackgroundKind =
  | "none"
  | "dot-grid"
  | "image"
  | "gradient"
  | "galaxy"
  | "grid-scan"
  | "letter-glitch"
  | "shape-grid";

export interface BackgroundInfo {
  id: string;
  title: string;
  description: string;
  kind: BackgroundKind | string;
  options: Record<string, unknown>;
  source: BackgroundSource;
  path?: string;
}

export interface BackgroundLoadError {
  folder: string;
  message: string;
}

export interface BackgroundList {
  directory: string;
  backgrounds: BackgroundInfo[];
  errors: BackgroundLoadError[];
}
