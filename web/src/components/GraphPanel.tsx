import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { GraphData, GraphEdge, GraphNode } from "../api/types";
import { layoutGraph } from "../lib/graphLayout";
import { IconGraph } from "./Icons";
import {
  navigateAtom,
  notesRevisionAtom,
} from "../state/atoms";

type Scope = "local" | "all";

export function GraphPanel({
  notebookId,
  activeNoteId,
  width = 320,
  height = 300,
  defaultScope = "local",
}: {
  notebookId: string;
  activeNoteId: string | null;
  width?: number;
  height?: number;
  defaultScope?: Scope;
}) {
  const revision = useAtomValue(notesRevisionAtom);
  const navigate = useSetAtom(navigateAtom);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(defaultScope);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .graph(notebookId)
      .then((data) => {
        if (cancelled) return;
        setGraph(data);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Could not load the graph",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, revision]);

  const shown = useMemo(
    () =>
      scope === "all" || !activeNoteId
        ? graph
        : localGraph(graph, activeNoteId),
    [activeNoteId, graph, scope],
  );

  if (loading && !graph) {
    return (
      <p className="py-10 text-center font-mono text-[10.5px] text-faint">
        Loading graph…
      </p>
    );
  }
  if (error) {
    return (
      <p className="rounded-lg bg-danger/10 px-3 py-2 font-mono text-[10.5px] text-danger">
        {error}
      </p>
    );
  }
  if (!shown || shown.nodes.length === 0) {
    return (
      <p className="py-10 text-center font-mono text-[10.5px] text-faint">
        No pages to graph.
      </p>
    );
  }

  const local = Boolean(activeNoteId) && scope === "local";
  const isolated = local && shown.nodes.length === 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-faint">
          <IconGraph className="h-3 w-3" />
          {local ? "Page graph" : "Notebook graph"}
        </div>
        {activeNoteId && (
          <div className="flex rounded-md border border-line bg-white/40 p-0.5">
            {(["local", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={`rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] transition ${
                  scope === value
                    ? "bg-panel-strong text-ink"
                    : "text-faint hover:text-ink-soft"
                }`}
              >
                {value === "local" ? "Local" : "Full"}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="font-mono text-[9px] text-faint">
        {shown.nodes.length} {shown.nodes.length === 1 ? "node" : "nodes"} ·{" "}
        {shown.edges.length} {shown.edges.length === 1 ? "link" : "links"}
      </p>

      <GraphCanvas
        nodes={shown.nodes}
        edges={shown.edges}
        activeNoteId={activeNoteId}
        width={width}
        height={height}
        onOpenNote={(path) => navigate({ view: "note", noteId: path })}
      />

      <p className="font-mono text-[9px] leading-relaxed text-faint">
        {isolated
          ? "This page has no connections yet. Switch to Full to see the notebook."
          : "Click a node to open its page. Hover to focus its links."}
      </p>
    </div>
  );
}

function localGraph(graph: GraphData | null, activeId: string): GraphData | null {
  if (!graph) return null;
  if (!graph.nodes.some((node) => node.id === activeId)) return graph;
  const ids = new Set([activeId]);
  for (const edge of graph.edges) {
    if (edge.source === activeId) ids.add(edge.target);
    if (edge.target === activeId) ids.add(edge.source);
  }
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
  };
}

function GraphCanvas({
  nodes,
  edges,
  activeNoteId,
  width,
  height,
  onOpenNote,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNoteId: string | null;
  width: number;
  height: number;
  onOpenNote: (path: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(
    () => layoutGraph(nodes, edges, width, height, activeNoteId),
    [activeNoteId, edges, height, nodes, width],
  );
  const byId = useMemo(
    () => new Map(layout.map((node) => [node.id, node])),
    [layout],
  );
  const focusId = hovered ?? activeNoteId;
  const labeled = useMemo(
    () =>
      new Set(
        [...layout]
          .sort((left, right) => right.degree - left.degree)
          .slice(0, 12)
          .map((node) => node.id),
      ),
    [layout],
  );
  const connected = useMemo(() => {
    if (!focusId) return null;
    const ids = new Set([focusId]);
    for (const edge of edges) {
      if (edge.source === focusId) ids.add(edge.target);
      if (edge.target === focusId) ids.add(edge.source);
    }
    return ids;
  }, [edges, focusId]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block w-full rounded-xl border border-line bg-white/35"
      style={{ height }}
      role="img"
      aria-label="Notebook link graph"
    >
      <g>
        {edges.map((edge, index) => {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          if (!source || !target) return null;
          const highlighted =
            !focusId ||
            edge.source === focusId ||
            edge.target === focusId;
          return (
            <line
              key={`${edge.source}-${edge.target}-${index}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={
                highlighted && focusId
                  ? "var(--color-accent)"
                  : "var(--color-line-strong)"
              }
              strokeWidth={highlighted && focusId ? 1.3 : 0.8}
              opacity={highlighted ? 0.62 : 0.15}
            />
          );
        })}
      </g>
      <g>
        {layout.map((node) => {
          const active = node.id === activeNoteId;
          const dimmed = connected !== null && !connected.has(node.id);
          const showLabel =
            nodes.length <= 26 ||
            node.id === focusId ||
            active ||
            labeled.has(node.id);
          const fill = active
            ? "var(--color-accent-strong)"
            : node.id === focusId
              ? "var(--color-accent)"
              : node.id.startsWith("journals/")
                ? "var(--color-panel-strong)"
                : "var(--color-canvas)";
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${node.title}`}
              onClick={() => onOpenNote(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenNote(node.id);
                }
              }}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              className="cursor-pointer outline-none"
              opacity={dimmed ? 0.32 : 1}
            >
              <title>{node.title}</title>
              <circle
                cx={node.x}
                cy={node.y}
                r={node.radius + (active ? 1.4 : 0)}
                fill={fill}
                stroke={
                  active || node.id === focusId
                    ? "var(--color-accent-strong)"
                    : "var(--color-line-strong)"
                }
                strokeWidth={active ? 2 : 1}
              />
              {showLabel && (
                <text
                  x={node.x}
                  y={node.y + node.radius + 9}
                  textAnchor="middle"
                  fill={
                    active ? "var(--color-ink)" : "var(--color-muted)"
                  }
                  fontSize={nodes.length > 80 ? 11 : 9}
                  fontFamily="var(--font-mono)"
                >
                  {truncate(node.title, nodes.length > 80 ? 10 : 16)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
