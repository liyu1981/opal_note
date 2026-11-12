import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

import type { GraphEdge, GraphNode } from "../api/types";

export type PositionedNode = GraphNode & {
  x: number;
  y: number;
  radius: number;
  degree: number;
};

type SimNode = SimulationNodeDatum & {
  id: string;
  title: string;
  tags: string[];
  degree: number;
  radius: number;
};

type SimLink = SimulationLinkDatum<SimNode>;

const LINK_DISTANCE = 82;
const CHARGE_STRENGTH = -140;
const CHARGE_DISTANCE = 420;
const ISOLATED_START_RADIUS = 180;
const ISOLATED_GAP = 58;

/**
 * A compact adaptation of Logseq's all-pages graph layout:
 *
 * - connected pages run through d3-force with link/charge/collision forces
 * - unlinked pages are arranged in deterministic rings around the connected
 *   cluster (Logseq's isolated-page placement)
 * - tick counts follow Logseq's small/medium/large graph schedule
 *
 * The result is deliberately synchronous so the React panel can render it
 * without an animation loop.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const radiusFor = (id: string) => {
    const d = degree.get(id) ?? 0;
    const base = id.startsWith("journals/") ? 4.4 : 3.8;
    return Math.min(12, base + 3.4 * Math.sqrt(d));
  };

  const linked: SimNode[] = [];
  const isolated: GraphNode[] = [];
  for (const node of nodes) {
    if ((degree.get(node.id) ?? 0) > 0) {
      linked.push({
        id: node.id,
        title: node.title,
        tags: node.tags,
        degree: degree.get(node.id) ?? 0,
        radius: radiusFor(node.id),
      });
    } else {
      isolated.push(node);
    }
  }

  const linkedIds = new Set(linked.map((node) => node.id));
  const simLinks: SimLink[] = edges
    .filter(
      (edge) =>
        linkedIds.has(edge.source) && linkedIds.has(edge.target),
    )
    .map((edge) => ({ source: edge.source, target: edge.target }));

  if (linked.length > 0) {
    const simulation = forceSimulation<SimNode>(linked)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.id)
          .distance(LINK_DISTANCE)
          .strength(0.82),
      )
      .force(
        "charge",
        forceManyBody<SimNode>()
          .strength(CHARGE_STRENGTH)
          .distanceMax(CHARGE_DISTANCE),
      )
      .force(
        "collision",
        forceCollide<SimNode>()
          .radius((node) => node.radius + 10)
          .strength(0.86)
          .iterations(2),
      )
      // Logseq's all-pages layout leaves Y unconstrained.
      .force("y", forceY<SimNode>(0).strength(0))
      .force("center", forceCenter(0, 0))
      .stop();

    const ticks =
      nodes.length <= 120
        ? 160
        : nodes.length <= 400
          ? 110
          : nodes.length <= 900
            ? 90
            : 70;
    for (let tick = 0; tick < ticks; tick += 1) simulation.tick();
  }

  const positioned: PositionedNode[] = linked.map((node) => ({
    id: node.id,
    title: node.title,
    tags: node.tags,
    degree: node.degree,
    radius: node.radius,
    x: node.x ?? 0,
    y: node.y ?? 0,
  }));

  if (isolated.length > 0) {
    const linkedRadius = graphRadius(positioned);
    const startRadius = Math.max(
      ISOLATED_START_RADIUS,
      linkedRadius + 96,
    );
    const sorted = [...isolated].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    let cursor = 0;
    let ring = 0;
    while (cursor < sorted.length) {
      const ringRadius = startRadius + ring * ISOLATED_GAP;
      const capacity = Math.max(
        14,
        Math.floor((2 * Math.PI * ringRadius) / 42),
      );
      const ringNodes = sorted.slice(cursor, cursor + capacity);
      const offset = ring * 0.41;
      ringNodes.forEach((node, index) => {
        const angle =
          offset + (index * Math.PI * 2) / Math.max(1, ringNodes.length);
        positioned.push({
          id: node.id,
          title: node.title,
          tags: node.tags,
          degree: 0,
          radius: radiusFor(node.id),
          x: Math.cos(angle) * ringRadius,
          y: Math.sin(angle) * ringRadius,
        });
      });
      cursor += capacity;
      ring += 1;
    }
  }

  // Fit the graph into the canvas without distorting its shape. Small graphs
  // keep a modest scale so a two-node local graph does not span edge to edge.
  const minX = Math.min(...positioned.map((node) => node.x - node.radius));
  const maxX = Math.max(...positioned.map((node) => node.x + node.radius));
  const minY = Math.min(...positioned.map((node) => node.y - node.radius));
  const maxY = Math.max(...positioned.map((node) => node.y + node.radius));
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const pad = Math.max(20, Math.min(width, height) * 0.08);
  const scale = Math.min(
    (width - pad * 2) / spanX,
    (height - pad * 2) / spanY,
    2,
  );
  const scaledWidth = spanX * scale;
  const scaledHeight = spanY * scale;
  const offsetX = (width - scaledWidth) / 2;
  const offsetY = (height - scaledHeight) / 2;

  return positioned.map((node) => ({
    ...node,
    x: nodes.length === 1 ? width / 2 : offsetX + (node.x - minX) * scale,
    y: nodes.length === 1 ? height / 2 : offsetY + (node.y - minY) * scale,
  }));
}

export type LiveGraphSimulation = {
  simulation: Simulation<SimNode, SimLink> | null;
  byId: Map<string, SimNode>;
};

/**
 * The static layout supplies the fitted seed and isolated rings. Connected
 * nodes then get a live d3 simulation so the graph visibly settles, and so
 * dragging one node can pull its neighbours through the link forces.
 */
export function createLiveSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  initialPositions: PositionedNode[],
): LiveGraphSimulation {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const initialById = new Map(
    initialPositions.map((node) => [node.id, node]),
  );
  const linked = nodes
    .filter((node) => (degree.get(node.id) ?? 0) > 0)
    .map((node) => {
      const position = initialById.get(node.id);
      const id = node.id;
      return {
        id,
        title: node.title,
        tags: node.tags,
        degree: degree.get(id) ?? 0,
        radius: position?.radius ??
          Math.min(
            12,
            (id.startsWith("journals/") ? 4.4 : 3.8) +
              3.4 * Math.sqrt(degree.get(id) ?? 0),
          ),
        x: position?.x ?? width / 2,
        y: position?.y ?? height / 2,
        vx: seededVelocity(id, 1) * 5,
        vy: seededVelocity(id, 2) * 5,
      };
    });

  if (linked.length === 0) {
    return { simulation: null, byId: new Map() };
  }

  const linkedIds = new Set(linked.map((node) => node.id));
  const simLinks: SimLink[] = edges
    .filter(
      (edge) =>
        linkedIds.has(edge.source) && linkedIds.has(edge.target),
    )
    .map((edge) => ({ source: edge.source, target: edge.target }));

  const simulation = forceSimulation<SimNode>(linked)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((node) => node.id)
        .distance(LINK_DISTANCE)
        .strength(0.82),
    )
    .force(
      "charge",
      forceManyBody<SimNode>()
        .strength(CHARGE_STRENGTH)
        .distanceMax(CHARGE_DISTANCE),
    )
    .force(
      "collision",
      forceCollide<SimNode>()
        .radius((node) => node.radius + 10)
        .strength(0.86)
        .iterations(2),
    )
    .force("center", forceCenter(width / 2, height / 2))
    // Anchors keep the live simulation near the Logseq-style seed while still
    // letting links pull neighbours when a node is dragged.
    .force(
      "x",
      forceX<SimNode>((node) => initialById.get(node.id)?.x ?? width / 2)
        .strength(0.055),
    )
    .force(
      "y",
      forceY<SimNode>((node) => initialById.get(node.id)?.y ?? height / 2)
        .strength(0.055),
    )
    .alpha(1)
    .restart();

  return {
    simulation,
    byId: new Map(linked.map((node) => [node.id, node])),
  };
}

function seededVelocity(id: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295 - 0.5) * 2;
}

function graphRadius(nodes: PositionedNode[]): number {
  if (nodes.length === 0) return 0;
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  return Math.max(maxX - minX, maxY - minY) / 2;
}
