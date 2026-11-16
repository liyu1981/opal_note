import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

import type {
  JournalPluginItem,
  JournalPluginResult,
  PluginAction,
  PluginUiListItem,
  PluginUiNode,
  PluginUiTone,
} from "../api/types";
import { formatJournalDate } from "../lib/journal";
import type { LinkTarget } from "../lib/livePreview";
import { GraphPanel } from "./GraphPanel";
import { IconCheck } from "./Icons";
import { LiveMarkdownEditor } from "./editor/LiveMarkdownEditor";
import { PluginCard } from "./PluginCard";

type RendererProps = {
  plugin: JournalPluginResult;
  onAction: (action: PluginAction) => void;
};

type PluginHostProps = RendererProps & {
  notebookId?: string;
  linkKeys?: Set<string>;
  linkTargets?: LinkTarget[];
  onWikiLink?: (target: string) => void;
  onTag?: (tag: string) => void;
};

type PluginRenderContext = {
  notebookId?: string;
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  onWikiLink: (target: string) => void;
  onTag: (tag: string) => void;
};

const EMPTY_LINK_KEYS = new Set<string>();
const EMPTY_LINK_TARGETS: LinkTarget[] = [];
const PLUGIN_CONTEXT = createContext<PluginRenderContext>({
  linkKeys: EMPTY_LINK_KEYS,
  linkTargets: EMPTY_LINK_TARGETS,
  onWikiLink: () => {},
  onTag: () => {},
});

const KIND_RENDERERS: Record<string, (props: RendererProps) => ReactNode> = {
  "todo-list": ({ plugin, onAction }) => (
    <PluginCard
      plugin={plugin}
      onOpen={(item) =>
        onAction({ type: "openNote", path: item.note_path })
      }
    />
  ),
};

/**
 * Renders a plugin result. Declarative schema UIs are preferred; fixed renderer
 * kinds and the legacy item card keep older plugins working.
 */
export function PluginHost({
  plugin,
  onAction,
  notebookId,
  linkKeys = EMPTY_LINK_KEYS,
  linkTargets = EMPTY_LINK_TARGETS,
  onWikiLink = () => {},
  onTag = () => {},
}: PluginHostProps) {
  if (plugin.error) {
    return <PluginErrorCard plugin={plugin} />;
  }
  if (plugin.ui && "schema" in plugin.ui) {
    return (
      <PLUGIN_CONTEXT.Provider
        value={{ notebookId, linkKeys, linkTargets, onWikiLink, onTag }}
      >
        <PluginSchemaView
          root={plugin.ui.root}
          fallbackTitle={plugin.title}
          onAction={onAction}
        />
      </PLUGIN_CONTEXT.Provider>
    );
  }
  if (plugin.ui && "kind" in plugin.ui) {
    const renderer = KIND_RENDERERS[plugin.ui.kind];
    if (renderer) return renderer({ plugin, onAction });
  }
  return <PluginItemsCard plugin={plugin} onAction={onAction} />;
}

function PluginErrorCard({ plugin }: { plugin: JournalPluginResult }) {
  return (
    <section className="overflow-hidden rounded-xl border border-danger/30 bg-paper">
      <header className="border-b border-line/60 px-3 py-2.5">
        <h3 className="font-sans text-[14px] font-semibold text-ink">
          {plugin.title}
        </h3>
      </header>
      <p className="p-3 font-mono text-[14px] leading-relaxed text-danger">
        {plugin.error}
      </p>
    </section>
  );
}

function PluginItemsCard({ plugin, onAction }: RendererProps) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-paper">
      <header className="flex items-start gap-2 border-b border-line/60 px-3 py-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-mark/60 text-ink-soft">
          <IconCheck className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-sans text-[14px] font-semibold text-ink">
              {plugin.title}
            </h3>
            <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[14px] text-faint">
              {plugin.items.length}
            </span>
          </div>
        </div>
      </header>
      <div className="p-1.5">
        {plugin.items.length === 0 ? (
          <p className="px-2 py-4 text-center font-mono text-[14px] text-faint">
            No items.
          </p>
        ) : (
          plugin.items.map((item) => (
            <PluginItemButton
              key={item.id}
              item={item}
              onAction={onAction}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PluginItemButton({
  item,
  onAction,
}: {
  item: JournalPluginItem;
  onAction: (action: PluginAction) => void;
}) {
  const detail = pluginItemDetail(item);
  const action = item.note_path
    ? { type: "openNote" as const, path: item.note_path }
    : null;
  const content = (
    <>
      {item.status && (
        <span
          className={`mt-0.5 h-3 w-3 shrink-0 rounded border ${
            item.status === "doing"
              ? "border-accent bg-accent-soft"
              : "border-line-strong bg-white/60"
          }`}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-mono text-[14px] leading-snug text-ink-soft">
          {item.title}
        </span>
        {detail && (
          <span className="mt-0.5 block truncate font-mono text-[14px] text-faint">
            {detail}
            {item.status === "doing" ? " · doing" : ""}
          </span>
        )}
      </span>
    </>
  );
  if (!action) {
    return <div className="flex w-full items-start gap-2 px-2 py-1.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onAction(action)}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-panel/70"
      title={`Open ${detail || item.title}`}
    >
      {content}
    </button>
  );
}

/**
 * Renders the allowlisted declarative UI schema. The server validates the same
 * shape, but the renderer repeats the type switch so an old/new API version
 * can never crash the workspace.
 */
function PluginSchemaView({
  root,
  fallbackTitle,
  onAction,
}: {
  root: PluginUiNode;
  fallbackTitle: string;
  onAction: (action: PluginAction) => void;
}) {
  return (
    <PluginNodeView
      node={root}
      onAction={onAction}
      fallbackTitle={fallbackTitle}
    />
  );
}

function PluginNodeView({
  node,
  onAction,
  fallbackTitle,
}: {
  node: PluginUiNode;
  onAction: (action: PluginAction) => void;
  fallbackTitle?: string;
}) {
  const children = node.children?.map((child, index) => (
    <PluginNodeView
      key={index}
      node={child}
      onAction={onAction}
      fallbackTitle={fallbackTitle}
    />
  ));

  switch (node.type) {
    case "card":
      return (
        <section className="overflow-hidden rounded-xl border border-line bg-paper">
          {(node.title || fallbackTitle) && (
            <header className="border-b border-line/60 px-3 py-2.5">
              <h3 className="font-sans text-[14px] font-semibold text-ink">
                {node.title ?? fallbackTitle}
              </h3>
            </header>
          )}
          <div className="space-y-2 p-3">{children}</div>
        </section>
      );
    case "section":
      return (
        <section className="space-y-1.5">
          {node.title && (
            <h4 className="font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-faint">
              {node.title}
            </h4>
          )}
          {children}
        </section>
      );
    case "row":
      return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
    case "heading": {
      const level = node.level ?? 3;
      const className =
        level === 1
          ? "font-serif text-[20px] font-semibold text-ink"
          : level === 2
            ? "font-serif text-[17px] font-semibold text-ink"
            : "font-sans text-[14px] font-semibold text-ink";
      return <h3 className={className}>{node.text}</h3>;
    }
    case "text":
      return (
        <p className={`font-sans text-[14px] leading-relaxed ${toneClass(node.tone)}`}>
          {node.text}
        </p>
      );
    case "badge":
      return (
        <span
          className={`inline-flex rounded px-1.5 py-0.5 font-mono text-[12px] ${toneBadgeClass(
            node.tone,
          )}`}
        >
          {node.text}
        </span>
      );
    case "list":
      return (
        <div className="space-y-0.5">
          {node.items && node.items.length > 0 ? (
            node.items.map((item, index) => (
              <PluginListItemView
                key={index}
                item={item}
                onAction={onAction}
              />
            ))
          ) : (
            <p className="px-2 py-3 text-center font-mono text-[14px] text-faint">
              {node.emptyText ?? "Nothing here."}
            </p>
          )}
        </div>
      );
    case "button":
      return (
        <button
          type="button"
          onClick={() => node.action && onAction(node.action)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-sans text-[14px] transition ${
            node.variant === "danger"
              ? "border-danger/30 text-danger hover:bg-danger/10"
              : node.variant === "ghost"
                ? "border-transparent text-muted hover:bg-panel hover:text-ink"
                : "border-line bg-white/60 text-ink-soft hover:bg-white hover:text-ink"
          }`}
        >
          {node.label}
        </button>
      );
    case "link":
      return (
        <button
          type="button"
          onClick={() => node.action && onAction(node.action)}
          className="inline-flex items-center gap-1 font-sans text-[14px] text-accent-strong underline decoration-accent/30 underline-offset-2 transition hover:text-ink"
        >
          {node.label}
        </button>
      );
    case "markdown":
      return <PluginMarkdown value={node.value ?? ""} />;
    case "graph":
      return (
        <PluginGraph
          title={node.title}
          scope={node.scope}
          includeTags={node.includeTags}
          height={node.height}
        />
      );
    case "separator":
      return <div className="border-t border-line/60" />;
    case "empty":
      return (
        <p className="px-2 py-4 text-center font-mono text-[14px] text-faint">
          {node.text ?? "Nothing here."}
        </p>
      );
    default:
      return null;
  }
}

function PluginMarkdown({ value }: { value: string }) {
  const context = useContext(PLUGIN_CONTEXT);
  if (!context.notebookId) {
    return (
      <p className="px-2 py-3 text-center font-mono text-[14px] text-faint">
        Markdown is unavailable without a notebook.
      </p>
    );
  }
  return (
    <div className="note-editor-surface overflow-hidden rounded-lg border border-line bg-paper">
      <LiveMarkdownEditor
        value={value}
        onChange={() => {}}
        onWikiLink={context.onWikiLink}
        onTag={context.onTag}
        notebookId={context.notebookId}
        notePath=""
        linkKeys={context.linkKeys}
        linkTargets={context.linkTargets}
        readOnly
        autoHeight
      />
    </div>
  );
}

function PluginGraph({
  title,
  scope,
  includeTags,
  height,
}: {
  title?: string;
  scope?: "local" | "all";
  includeTags?: boolean;
  height?: number;
}) {
  const { notebookId } = useContext(PLUGIN_CONTEXT);
  if (!notebookId) {
    return (
      <p className="px-2 py-3 text-center font-mono text-[14px] text-faint">
        Graph is unavailable without a notebook.
      </p>
    );
  }
  return (
    <GraphPanel
      notebookId={notebookId}
      activeNoteId={null}
      width={320}
      height={height ?? 220}
      defaultScope={scope ?? "all"}
      defaultIncludeTags={includeTags ?? true}
      title={title}
    />
  );
}

function PluginListItemView({
  item,
  onAction,
}: {
  item: PluginUiListItem;
  onAction: (action: PluginAction) => void;
}) {
  const detail = item.detail ?? item.note_path ?? "";
  const shownDetail = item.note_path?.startsWith("journals/")
    ? formatJournalDate(detail)
    : detail;
  const content = (
    <>
      {item.status && (
        <span
          className={`mt-0.5 h-3 w-3 shrink-0 rounded border ${
            item.status === "doing"
              ? "border-accent bg-accent-soft"
              : "border-line-strong bg-white/60"
          }`}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-mono text-[14px] leading-snug text-ink-soft">
          {item.title}
        </span>
        {shownDetail && (
          <span className="mt-0.5 block truncate font-mono text-[14px] text-faint">
            {shownDetail}
            {item.status === "doing" ? " · doing" : ""}
          </span>
        )}
      </span>
    </>
  );
  if (!item.action) {
    return <div className="flex w-full items-start gap-2 px-2 py-1.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onAction(item.action as PluginAction)}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-panel/70"
      title={`Open ${shownDetail || item.title}`}
    >
      {content}
    </button>
  );
}

function toneClass(tone?: PluginUiTone): string {
  switch (tone) {
    case "muted":
      return "text-muted";
    case "accent":
      return "text-accent-strong";
    case "danger":
      return "text-danger";
    case "success":
      return "text-mint";
    default:
      return "text-ink-soft";
  }
}

function toneBadgeClass(tone?: PluginUiTone): string {
  switch (tone) {
    case "accent":
      return "bg-accent-soft text-accent-strong";
    case "danger":
      return "bg-danger/10 text-danger";
    case "success":
      return "bg-mint/10 text-mint";
    default:
      return "bg-panel text-muted";
  }
}

function pluginItemDetail(item: JournalPluginItem): string {
  const detail = item.detail ?? item.note_path ?? "";
  return item.note_path?.startsWith("journals/")
    ? formatJournalDate(detail)
    : detail;
}
