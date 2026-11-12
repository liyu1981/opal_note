import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useAtomValue } from "jotai";

import { api } from "../api/client";
import type { GraphData, GraphEdge, GraphNode } from "../api/types";
import {
  createLiveSimulation,
  layoutGraph,
  type LiveGraphSimulation,
  type PositionedNode,
} from "../lib/graphLayout";
import {
  IconGraph,
  IconMinus,
  IconPlus,
  IconRefresh,
} from "./Icons";
import { notesRevisionAtom } from "../state/atoms";
import { useAppNavigate } from "../lib/appNavigation";

type Scope = "local" | "all";

export function GraphPanel({
  notebookId,
  activeNoteId,
  width = 320,
  height = 300,
  defaultScope = "local",
  fill = false,
  title,
}: {
  notebookId: string;
  activeNoteId: string | null;
  width?: number;
  height?: number;
  defaultScope?: Scope;
  fill?: boolean;
  title?: string;
}) {
  const revision = useAtomValue(notesRevisionAtom);
  const navigate = useAppNavigate();
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
      <p className="py-10 text-center font-mono text-[14px] text-faint">
        Loading graph…
      </p>
    );
  }
  if (error) {
    return (
      <p className="rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] text-danger">
        {error}
      </p>
    );
  }
  if (!shown || shown.nodes.length === 0) {
    return (
      <p className="py-10 text-center font-mono text-[14px] text-faint">
        No pages to graph.
      </p>
    );
  }

  const local = Boolean(activeNoteId) && scope === "local";
  const isolated = local && shown.nodes.length === 1;

  if (fill) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-3">
          <div>
            <div className="flex items-center gap-1.5 font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
              <IconGraph className="h-3.5 w-3.5" />
              Notebook graph
            </div>
            <h1 className="mt-1 font-mono text-[24px] font-semibold tracking-tight text-ink">
              {title ?? "Graph"}
            </h1>
          </div>
          <div className="text-right">
            <p className="font-mono text-[14px] text-faint">
              {shown.nodes.length} {shown.nodes.length === 1 ? "node" : "nodes"}{" "}
              · {shown.edges.length}{" "}
              {shown.edges.length === 1 ? "link" : "links"}
            </p>
            <p className="mt-1 font-mono text-[14px] text-faint">
              Click to select · double-click to open
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <GraphCanvas
            nodes={shown.nodes}
            edges={shown.edges}
            activeNoteId={activeNoteId}
            width={width}
            height={height}
            fill
            onOpenNote={(path) => navigate({ view: "note", noteId: path })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[14px] font-semibold uppercase tracking-[0.12em] text-faint">
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
                className={`rounded px-1.5 py-0.5 font-mono text-[14px] uppercase tracking-[0.08em] transition ${
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

      <p className="font-mono text-[14px] text-faint">
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

      <p className="font-mono text-[14px] leading-relaxed text-faint">
        {isolated
          ? "This page has no connections yet. Switch to Full to see the notebook."
          : "Click a node to highlight its links; double-click to open its page."}
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

type ViewTransform = { x: number; y: number; k: number };
type DragState =
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      viewX: number;
      viewY: number;
      moved: boolean;
    }
  | {
      kind: "node";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      nodeId: string;
      nodeX: number;
      nodeY: number;
      startGraphX: number;
      startGraphY: number;
      moved: boolean;
    };

function GraphCanvas({
  nodes,
  edges,
  activeNoteId,
  width,
  height,
  fill = false,
  onOpenNote,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNoteId: string | null;
  width: number;
  height: number;
  fill?: boolean;
  onOpenNote: (path: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastNodeClickRef = useRef<{ id: string; time: number } | null>(null);
  const simulationRef = useRef<LiveGraphSimulation | null>(null);
  const autoFitRef = useRef(true);
  const [size, setSize] = useState({ width, height });
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(activeNoteId);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const nextWidth = host.clientWidth;
      const nextHeight = host.clientHeight;
      if (nextWidth > 0 && nextHeight > 0) {
        setSize({ width: nextWidth, height: nextHeight });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const initialLayout = useMemo(
    () => layoutGraph(nodes, edges, size.width, size.height),
    [edges, nodes, size.height, size.width],
  );
  const [positions, setPositions] =
    useState<PositionedNode[]>(initialLayout);

  useEffect(() => {
    autoFitRef.current = true;
    setPositions(initialLayout);
    setView(fitView(initialLayout, size.width, size.height));
    setSelectedId(activeNoteId);

    const live = createLiveSimulation(
      nodes,
      edges,
      size.width,
      size.height,
      initialLayout,
    );
    simulationRef.current = live;
    const onTick = () => {
      const next = initialLayout.map((node) => {
        const simulated = live.byId.get(node.id);
        return simulated
          ? {
              ...node,
              x: simulated.x ?? node.x,
              y: simulated.y ?? node.y,
            }
          : node;
      });
      setPositions(next);
      if (autoFitRef.current) {
        setView(fitView(next, size.width, size.height));
      }
    };
    live.simulation?.on("tick", onTick);

    return () => {
      live.simulation?.stop();
      live.simulation?.on("tick", null);
      simulationRef.current = null;
    };
  }, [
    activeNoteId,
    edges,
    initialLayout,
    nodes,
    size.height,
    size.width,
  ]);

  const positionsById = useMemo(
    () => new Map(positions.map((node) => [node.id, node])),
    [positions],
  );
  const focusId = hovered ?? selectedId ?? activeNoteId;
  const labelIds = useMemo(
    () => selectLabelIds(positions, focusId, nodes.length),
    [focusId, nodes.length, positions],
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

  function toGraph(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) * (size.width / rect.width);
    const py = (clientY - rect.top) * (size.height / rect.height);
    return {
      x: (px - view.x) / view.k,
      y: (py - view.y) / view.k,
    };
  }

  function startPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    autoFitRef.current = false;
    dragRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewX: view.x,
      viewY: view.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(
    event: ReactPointerEvent<SVGGElement>,
    node: PositionedNode,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    autoFitRef.current = false;
    const start = toGraph(event.clientX, event.clientY);
    const simulated = simulationRef.current?.byId.get(node.id);
    if (simulated) {
      simulated.fx = node.x;
      simulated.fy = node.y;
    }
    dragRef.current = {
      kind: "node",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      nodeId: node.id,
      nodeX: node.x,
      nodeY: node.y,
      startGraphX: start.x,
      startGraphY: start.y,
      moved: false,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dxClient = event.clientX - drag.startClientX;
    const dyClient = event.clientY - drag.startClientY;
    if (Math.abs(dxClient) + Math.abs(dyClient) > 3) drag.moved = true;

    if (drag.kind === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = dxClient * (size.width / rect.width);
      const dy = dyClient * (size.height / rect.height);
      setView((current) => ({
        ...current,
        x: drag.viewX + dx,
        y: drag.viewY + dy,
      }));
      return;
    }

    if (!drag.moved) return;
    const point = toGraph(event.clientX, event.clientY);
    const nextX = drag.nodeX + (point.x - drag.startGraphX);
    const nextY = drag.nodeY + (point.y - drag.startGraphY);
    const live = simulationRef.current;
    const simulated = live?.byId.get(drag.nodeId);
    if (live?.simulation && simulated) {
      simulated.fx = nextX;
      simulated.fy = nextY;
      live.simulation.alphaTarget(0.3).restart();
    }
    setPositions((current) =>
      current.map((node) =>
        node.id === drag.nodeId ? { ...node, x: nextX, y: nextY } : node,
      ),
    );
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    if (drag.kind === "node") {
      const live = simulationRef.current;
      const simulated = live?.byId.get(drag.nodeId);
      if (simulated) {
        simulated.fx = null;
        simulated.fy = null;
        live?.simulation?.alphaTarget(0);
        if (drag.moved) {
          live?.simulation
            ?.alpha(Math.max(live.simulation.alpha(), 0.35))
            .restart();
        }
      }
    }

    if (drag.moved) return;
    if (drag.kind === "node") {
      const now = performance.now();
      const previous = lastNodeClickRef.current;
      if (
        previous &&
        previous.id === drag.nodeId &&
        now - previous.time < 320
      ) {
        lastNodeClickRef.current = null;
        onOpenNote(drag.nodeId);
        return;
      }
      lastNodeClickRef.current = { id: drag.nodeId, time: now };
      setSelectedId(drag.nodeId);
    } else {
      lastNodeClickRef.current = null;
      setSelectedId(null);
    }
  }

  function zoomAt(px: number, py: number, factor: number) {
    autoFitRef.current = false;
    setView((current) => {
      const nextK = Math.min(3.2, Math.max(0.35, current.k * factor));
      const worldX = (px - current.x) / current.k;
      const worldY = (py - current.y) / current.k;
      return {
        k: nextK,
        x: px - worldX * nextK,
        y: py - worldY * nextK,
      };
    });
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (size.width / rect.width);
    const py = (event.clientY - rect.top) * (size.height / rect.height);
    zoomAt(px, py, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  function resetView() {
    autoFitRef.current = true;
    const live = simulationRef.current;
    if (live?.simulation) {
      const initialById = new Map(
        initialLayout.map((node) => [node.id, node]),
      );
      for (const node of live.simulation.nodes()) {
        const initial = initialById.get(node.id);
        if (!initial) continue;
        node.x = initial.x;
        node.y = initial.y;
        node.vx = 0;
        node.vy = 0;
        node.fx = null;
        node.fy = null;
      }
      live.simulation.alpha(1).restart();
    }
    setPositions(initialLayout);
    setView(fitView(initialLayout, size.width, size.height));
  }

  return (
    <div
      ref={hostRef}
      className={
        fill
          ? "relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-xl border border-line bg-graph-bg"
          : "relative touch-none select-none overflow-hidden rounded-xl border border-line bg-graph-bg"
      }
      style={fill ? undefined : { height }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="block h-full w-full cursor-grab active:cursor-grabbing"
        role="application"
        aria-label="Notebook link graph"
        onPointerDown={startPan}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g>
            {edges.map((edge, index) => {
              const source = positionsById.get(edge.source);
              const target = positionsById.get(edge.target);
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
                      : "var(--color-graph-edge)"
                  }
                  strokeWidth={highlighted && focusId ? 1.5 : 1}
                  opacity={highlighted ? 0.72 : 0.22}
                />
              );
            })}
          </g>
          <g>
            {positions.map((node) => {
              const selected =
                node.id === selectedId ||
                (selectedId === null && node.id === activeNoteId);
              const dimmed = connected !== null && !connected.has(node.id);
              const showLabel =
                nodes.length <= 26 ||
                node.id === focusId ||
                node.id === activeNoteId ||
                labelIds.has(node.id);
              const fill = selected
                ? "var(--color-accent-strong)"
                : node.id === focusId
                  ? "var(--color-accent)"
                  : node.id.startsWith("journals/")
                    ? "var(--color-graph-node-journal)"
                    : "var(--color-graph-node)";
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${node.title}`}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => startNodeDrag(event, node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onOpenNote(node.id);
                    }
                  }}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  className="cursor-pointer outline-none"
                  opacity={dimmed ? 0.22 : 1}
                >
                  <title>{node.title}</title>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + (selected ? 1.4 : 0)}
                    fill={fill}
                    stroke={
                      selected || node.id === focusId
                        ? "var(--color-accent-strong)"
                        : "var(--color-graph-node)"
                    }
                    strokeWidth={selected ? 2 : 1}
                  />
                  {showLabel && (
                    <text
                      x={node.x}
                      y={node.y + node.radius + 9}
                      textAnchor="middle"
                      fill={
                        selected || node.id === focusId
                          ? "var(--color-ink)"
                          : "var(--color-graph-label)"
                      }
                      fontSize={12}
                      fontFamily="var(--font-mono)"
                    >
                      {truncate(node.title, 18)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-line bg-canvas/90 p-0.5 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={() => zoomAt(size.width / 2, size.height / 2, 1.25)}
          className="rounded p-1 text-muted transition hover:bg-panel hover:text-ink"
          aria-label="Zoom in"
          title="Zoom in"
        >
          <IconPlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => zoomAt(size.width / 2, size.height / 2, 1 / 1.25)}
          className="rounded p-1 text-muted transition hover:bg-panel hover:text-ink"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <IconMinus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="rounded p-1 text-muted transition hover:bg-panel hover:text-ink"
          aria-label="Reset graph view"
          title="Reset graph view"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Choose labels with a simple occupancy pass, like Logseq's label layout:
 * active/hovered and high-degree nodes win, then nearby labels are skipped.
 */
function fitView(
  positions: PositionedNode[],
  width: number,
  height: number,
): ViewTransform {
  if (positions.length === 0) return { x: 0, y: 0, k: 1 };
  const pad = 24;
  const minX = Math.min(...positions.map((node) => node.x - node.radius));
  const maxX = Math.max(...positions.map((node) => node.x + node.radius));
  const minY = Math.min(...positions.map((node) => node.y - node.radius));
  const maxY = Math.max(...positions.map((node) => node.y + node.radius));
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (width - pad * 2) / spanX,
    (height - pad * 2) / spanY,
    2.2,
  );
  return {
    k: scale,
    x: (width - spanX * scale) / 2 - minX * scale,
    y: (height - spanY * scale) / 2 - minY * scale,
  };
}

function selectLabelIds(
  layout: PositionedNode[],
  focusId: string | null,
  nodeCount: number,
): Set<string> {
  if (nodeCount <= 26) return new Set(layout.map((node) => node.id));

  const sorted = [...layout].sort((left, right) => {
    if (left.id === focusId) return -1;
    if (right.id === focusId) return 1;
    return right.degree - left.degree || left.id.localeCompare(right.id);
  });
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const ids = new Set<string>();
  const fontSize = 12;

  for (const node of sorted) {
    if (node.degree === 0 && node.id !== focusId && nodeCount > 80) {
      continue;
    }
    const text = truncate(node.title, 18);
    const width = text.length * fontSize * 0.6;
    const top = node.y + node.radius + 2;
    const box = {
      left: node.x - width / 2,
      right: node.x + width / 2,
      top,
      bottom: top + fontSize + 2,
    };
    if (
      boxes.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      )
    ) {
      continue;
    }
    if (node.id !== focusId) {
      const hitsNode = layout.some(
        (other) =>
          other.id !== node.id &&
          box.left < other.x + other.radius &&
          box.right > other.x - other.radius &&
          box.top < other.y + other.radius &&
          box.bottom > other.y - other.radius,
      );
      if (hitsNode) continue;
    }
    boxes.push(box);
    ids.add(node.id);
    if (ids.size >= 40) break;
  }
  return ids;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
