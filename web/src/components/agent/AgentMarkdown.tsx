import type { ComponentType } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeExternalUrl } from "../../lib/markdown";
import { useAppNavigate } from "../../lib/appNavigation";

/**
 * Markdown renderer for ReAgent chat bubbles.
 *
 * ReAgent's default is a plain `<pre>`; this is the same GFM rendering our
 * own notes use (tables, task lists, strikethrough, autolinks, fenced code),
 * themed with the app tokens so a chat bubble reads like a note.
 *
 * `ReAgentMarkdown` is `ComponentType<{ content; theme? }>`; `theme` is ignored
 * because the app has one palette and `agent-surface` already re-points the
 * ReAgent tokens.
 */
function linkifyWikilinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
    const label = target.trim();
    return `[${label}](note:${label})`;
  });
}

export const AgentMarkdown: ComponentType<{ content: string; theme?: "light" | "dark" }> =
  ({ content }) => {
    const navigate = useAppNavigate();
    const linked = linkifyWikilinks(content);
    // ReAgent invokes us as <Markdown content=… />; rendering a single string
    // here keeps the bubble's markup flat and prevents a nested <p> wrapper.
    return (
    <div className="agent-markdown font-sans text-sm leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("note:")) {
              const noteId = decodeURIComponent(href.slice("note:".length));
              return (
                <button
                  type="button"
                  onClick={() => navigate({ view: "note", noteId })}
                  className="text-accent-strong underline underline-offset-2 hover:text-accent"
                >
                  {children}
                </button>
              );
            }
            const safe = href ? safeExternalUrl(href) : null;
            return safe ? (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-strong underline underline-offset-2 hover:text-accent"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          code: ({ children, className }) =>
            className ? (
              <code className="block overflow-x-auto rounded-md border border-line bg-canvas/60 p-2 font-mono text-xs text-ink">
                {children}
              </code>
            ) : (
              <code className="rounded bg-canvas/60 px-1 py-0.5 font-mono text-xs text-ink">
                {children}
              </code>
            ),
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-line pl-3 text-muted-foreground last:mb-0">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <h1 className="mb-1 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-sm font-medium">{children}</h3>,
          hr: () => <hr className="my-2 border-line" />,
        }}
      >
        {linked}
      </ReactMarkdown>
    </div>
  );
};

