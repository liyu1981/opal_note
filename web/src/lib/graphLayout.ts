import type { GraphEdge, GraphNode } from "../api/types";

export type PositionedNode = GraphNode & {
  x: number;
  y: number;
  radius: number;
  degree: number;
};

/**
 * Small deterministic force layout for the notebook graph. It runs in one
 * synchronous pass (no animation) so the panel stays cheap and predictable.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  focusId: string | null = null,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const pad = Math.max(20, Math.min(width, height) * 0.08);
  const centerX = width / 2;
  const centerY = height / 2;
  const seeded = nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2;
    const spread = Math.min(width, height) * 0.3;
    return {
      ...node,
      x: centerX + Math.cos(angle) * spread,
      y: centerY + Math.sin(angle) * spread,
      vx: 0,
      vy: 0,
      degree: 0,
      radius: 5,
    };
  });

  const byId = new Map(seeded.map((node) => [node.id, node]));
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  const iterations = seeded.length > 80 ? 150 : 260;
  for (let step = 0; step < iterations; step += 1) {
    // Repel every pair so disconnected pages still spread out.
    for (let i = 0; i < seeded.length; i += 1) {
      const a = seeded[i];
      if (!a) continue;
      for (let j = i + 1; j < seeded.length; j += 1) {
        const b = seeded[j];
        if (!b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          dx = (i + 1) * 0.1;
          dy = (j + 1) * 0.1;
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        const force = Math.min(18, 900 / distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Link springs pull connected pages together.
    for (const edge of edges) {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - Math.min(width, height) * 0.22) * 0.018;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of seeded) {
      node.vx += (centerX - node.x) * 0.0025;
      node.vy += (centerY - node.y) * 0.0025;
      if (focusId && node.id === focusId) {
        node.vx += (centerX - node.x) * 0.006;
        node.vy += (centerY - node.y) * 0.006;
      }
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x = Math.max(pad, Math.min(width - pad, node.x + node.vx));
      node.y = Math.max(pad, Math.min(height - pad, node.y + node.vy));
    }
  }

  const xs = seeded.map((node) => node.x);
  const ys = seeded.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  // Don't stretch a tiny local graph across the entire canvas. Large graphs
  // use the available space; small ones keep a comfortable centered cluster.
  const scale = Math.min(
    (width - pad * 2) / spanX,
    (height - pad * 2) / spanY,
    2.2,
  );
  const scaledWidth = spanX * scale;
  const scaledHeight = spanY * scale;
  const offsetX = (width - scaledWidth) / 2;
  const offsetY = (height - scaledHeight) / 2;

  return seeded.map((node) => ({
    id: node.id,
    title: node.title,
    tags: node.tags,
    degree: node.degree,
    radius: Math.min(12, 4.5 + Math.sqrt(node.degree + 1) * 2.4),
    x:
      seeded.length === 1
        ? centerX
        : offsetX + (node.x - minX) * scale,
    y:
      seeded.length === 1
        ? centerY
        : offsetY + (node.y - minY) * scale,
  }));
}
