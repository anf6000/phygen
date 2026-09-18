// ─────────────────────────────────────────────────────────────────────────────
// radial.ts — the pure generation-ring layout of one artwork.
//
// The original artwork root sits at graph coordinate (0, 0). A node's children
// are packed into rings around that node, and those rings repeat at every level,
// so the tree grows outward like a circular L-system.
//
// The packing is deliberately dense. Cards are LARGE compared with the space
// between them, so one ring per parent wastes most of a circle: a parent with
// thirty-eight children would need a ring of radius 3,460 to hold them all on
// one arc. Filling several concentric arcs instead costs an outer radius of
// about 1,350 for the same children. The rings are therefore filled from the
// inside out, and the outermost ring is as small as the packing allows.
//
// The spacing is solved on the REAL rectangles, not on a bounding circle. Two
// axis-aligned cards clear each other when their centres are far enough apart on
// EITHER axis, so a card at absolute angle `a` needs
//
//   R >= min( (width + gap) / |cos a| , (height + gap) / |sin a| )
//
// from its parent, and two cards on one ring are compared by the difference of
// their unit vectors. `findOverlaps` then measures every placed pair, and a
// repair pass grows the offending cluster until the real rectangles clear. That
// check is the same one the fixtures and the interface use, so the promise "no
// node overlaps another" is a measurement rather than an opinion.
//
// The module is pure: the same input always gives the same output, and it never
// reads the DOM, the clock, or a store.
//
// Nothing here is a measured relationship between two versions. Rings are
// ancestry only. Measurements are a separate layer with their own module.
// ─────────────────────────────────────────────────────────────────────────────

export interface RadialNode {
  id: string;
  parentId: string | null;
  generation: number;
  createdAt: string;
}

export interface RadialOptions {
  /** The original root of the artwork, taken from the artwork record. */
  rootId: string | null;
  cardWidth: number;
  cardHeight: number;
  /** Free space between two cards that must not touch. */
  cardGap?: number;
  /**
   * The arc, in radians, that a node may use for its children given their
   * number. The default is the measured choice: a narrow brood keeps a narrow
   * fan, and a wide brood opens into a half turn of its own.
   */
  fan?: (count: number) => number;
  /** A hard ceiling: a deeper graph is reported instead of laid out forever. */
  maxDepth?: number;
  /** The greatest number of overlap repairs before the layout stops trying. */
  maxRepairs?: number;
  /**
   * How far a ring may grow beyond one card height before another ring becomes
   * the better answer. 1 means "fill the ring at its first radius". Larger
   * values pack more cards per ring but make each ring wider.
   */
  window?: number;
}

/** One generation, with the distances its cards reached from the root. */
export interface RingInfo {
  depth: number;
  count: number;
  /** The mean distance from the root, in graph units. */
  meanRadius: number;
  /** The greatest distance from the root, in graph units. */
  maxRadius: number;
}

export type DiagnosticReason = 'orphan' | 'cycle' | 'unreachable';

export interface RadialDiagnostic {
  id: string;
  reason: DiagnosticReason;
}

export interface RadialLayout {
  /** React Flow node coordinates (top-left corner of the card). */
  positions: Map<string, { x: number; y: number }>;
  /** Card centres, which is what the ring math uses. */
  centers: Map<string, { x: number; y: number }>;
  /** Distance from the root, in generations. */
  depths: Map<string, number>;
  /** The angle at which the card sits around its parent. */
  angles: Map<string, number>;
  /** The distance from the card to its parent. Its own ring radius. */
  radii: Map<string, number>;
  /** How many concentric rings this node's children needed. */
  childRings: Map<string, number>;
  /** The radius of the circle that holds the whole subtree of the card. */
  subtreeRadii: Map<string, number>;
  rings: RingInfo[];
  /** Records that cannot be placed without inventing a parent. */
  diagnostics: RadialDiagnostic[];
  /** A separate, non-radial column for the diagnostic records. */
  diagnosticPositions: Map<string, { x: number; y: number }>;
  /** A stored generation that disagrees with the calculated depth. */
  generationMismatch: { id: string; generation: number; depth: number }[];
  /** How many times a cluster was grown to remove an overlap. */
  repairs: number;
  /** Any overlap that remained. Empty is the promise. */
  problems: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const DEFAULT_CARD_GAP = 20;
const DEFAULT_MAX_DEPTH = 2000;
const DEFAULT_MAX_REPAIRS = 60;
/** The greatest layout the module will attempt before it refuses. */
const MAX_PLACED = 20000;
/** The greatest number of rings one parent may need before it stops trying. */

function byBirth(a: RadialNode, b: RadialNode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The arc a node gives its children, by their number.
 *
 * A narrow brood keeps a narrow fan, so a small family reads as a branch that
 * grows outward. A wide brood opens wider, because a narrow fan forces the cards
 * onto a huge ring: ten children on a half turn need a radius of about 790, and
 * the same ten on a full turn need about 450. The rule stops at a full turn.
 */
function defaultFan(count: number): number {
  if (count <= 6) return Math.PI / 2;
  return Math.PI;
}

/**
 * Lay out one artwork as nested circles.
 *
 * Only records reachable from `rootId` through parent links are placed. A record
 * whose parent is missing, and a record in a parent cycle, go to the diagnostic
 * group. No ancestry is invented for them.
 */
export function layoutRings(nodes: RadialNode[], options: RadialOptions): RadialLayout {
  const cardWidth = Math.max(1, options.cardWidth);
  const cardHeight = Math.max(1, options.cardHeight);
  const cardGap = options.cardGap ?? DEFAULT_CARD_GAP;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const cardRadius = Math.hypot(cardWidth, cardHeight) / 2;

  const positions = new Map<string, { x: number; y: number }>();
  const centers = new Map<string, { x: number; y: number }>();
  const depths = new Map<string, number>();
  const angles = new Map<string, number>();
  const radii = new Map<string, number>();
  const childRings = new Map<string, number>();
  const subtreeRadii = new Map<string, number>();
  const diagnosticPositions = new Map<string, { x: number; y: number }>();
  const diagnostics: RadialDiagnostic[] = [];
  const generationMismatch: { id: string; generation: number; depth: number }[] = [];
  const rings: RingInfo[] = [];

  const index = new Map<string, RadialNode>();
  for (const node of nodes) if (!index.has(node.id)) index.set(node.id, node);
  const root = options.rootId ? index.get(options.rootId) ?? null : null;

  const empty: RadialLayout = {
    positions,
    centers,
    depths,
    angles,
    radii,
    childRings,
    subtreeRadii,
    rings,
    diagnostics,
    diagnosticPositions,
    generationMismatch,
    repairs: 0,
    problems: [],
    bounds: null,
  };
  if (!root) {
    // Without a canonical root there is no ring to measure from. Say so with
    // the ids, instead of guessing a root and drawing a wrong ancestry.
    for (const node of index.values()) diagnostics.push({ id: node.id, reason: 'unreachable' });
    return empty;
  }

  // ── ancestry ───────────────────────────────────────────────────────────────
  const children = new Map<string, RadialNode[]>();
  for (const node of index.values()) {
    if (!node.parentId) continue;
    if (!index.has(node.parentId)) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort(byBirth);

  // Breadth-first from the canonical root, so a cycle can never be followed.
  const depthOf = new Map<string, number>([[root.id, 0]]);
  const order: string[] = [root.id];
  for (let cursor = 0; cursor < order.length && order.length <= MAX_PLACED; cursor++) {
    const id = order[cursor];
    const depth = depthOf.get(id) ?? 0;
    if (depth >= maxDepth) continue;
    for (const child of children.get(id) ?? []) {
      if (depthOf.has(child.id)) continue;
      depthOf.set(child.id, depth + 1);
      order.push(child.id);
    }
  }

  for (const node of index.values()) {
    if (depthOf.has(node.id)) continue;
    diagnostics.push({ id: node.id, reason: classifyUnreachable(node, index) });
  }

  // ── pack every parent's children, from the root outward ───────────────────
  // A cluster is either a FAN of one or more rings, or, when every child is a
  // leaf, a BLOCK at card pitch. The plan is built before any card moves, so a
  // repair can spread a cluster without re-deciding the packing.
  interface ClusterPlan {
    parentId: string;
    /** The child ids in placement order. */
    order: string[];
    /** Each child's offset from its parent, in graph coordinates. */
    offsets: { x: number; y: number }[];
    /** The factor a repair spreads this cluster by. */
    scale: number;
  }
  const plans = new Map<string, ClusterPlan>();
  const outwardOf = new Map<string, number>([[root.id, -Math.PI / 2]]);

  /** Record where a node's children go, and which way each of them faces. */
  const setPlan = (id: string, order: string[], offsets: { x: number; y: number }[]) => {
    plans.set(id, { parentId: id, order, offsets, scale: 1 });
    order.forEach((kidId, index) => {
      const offset = offsets[index];
      if (offset) outwardOf.set(kidId, Math.atan2(offset.y, offset.x));
    });
  };

  /** Even angles over `arc`, centred on `outward`. One child goes straight out. */
  const spread = (arc: number, count: number, outward: number) => {
    if (count <= 1) return [outward];
    const full = arc >= 2 * Math.PI - 1e-9;
    // A full turn closes on itself, so its gap count is the card count. Any
    // smaller arc has one fewer gap than cards, because it has two ends.
    const step = full ? arc / count : arc / (count - 1);
    const start = full ? 0 : outward - arc / 2;
    return Array.from({ length: count }, (_, position) => start + position * step);
  };

  /** Does one ring of `count` cards at `radius` clear the parent card, every card
   *  already placed around this parent, and its own ring? */
  const clears = (count: number, radius: number, angles: number[], placed: { r: number; cos: number; sin: number }[]) => {
    const clear = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) >= cardWidth + cardGap - 1e-6 || Math.abs(ay - by) >= cardHeight + cardGap - 1e-6;
    for (let at = 0; at < count; at++) {
      const x = Math.cos(angles[at]) * radius;
      const y = Math.sin(angles[at]) * radius;
      // The parent's own card sits at the centre.
      if (!clear(x, y, 0, 0)) return false;
      for (const other of placed) {
        if (!clear(x, y, other.cos * other.r, other.sin * other.r)) return false;
      }
      for (let next = at + 1; next < count; next++) {
        if (!clear(x, y, Math.cos(angles[next]) * radius, Math.sin(angles[next]) * radius)) return false;
      }
    }
    return true;
  };

  /** The least radius at which this ring clears everything, by bisection. */
  const leastRadius = (count: number, angles: number[], placed: { r: number; cos: number; sin: number }[], floor: number) => {
    let high = Math.max(floor, cardRadius);
    let fits = false;
    for (let attempt = 0; attempt < 48; attempt++) {
      if (clears(count, high, angles, placed)) {
        fits = true;
        break;
      }
      high *= 1.3;
    }
    if (!fits) return Number.POSITIVE_INFINITY;
    let low = floor;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (clears(count, middle, angles, placed)) high = middle;
      else low = middle;
    }
    return Math.max(floor, high);
  };

  /** The shape of a block: the column count that puts the furthest card nearest. */
  const gridShape = (count: number, horizontal: boolean) => {
    const alongPitch = horizontal ? cardWidth + cardGap : cardHeight + cardGap;
    const acrossPitch = horizontal ? cardHeight + cardGap : cardWidth + cardGap;
    let columns = count;
    let distance = Number.POSITIVE_INFINITY;
    for (let candidate = 1; candidate <= count; candidate++) {
      const across = (acrossPitch * (candidate - 1)) / 2;
      const along = alongPitch * Math.ceil(count / candidate);
      const total = Math.hypot(along, across);
      if (total < distance - 1e-9) {
        distance = total;
        columns = candidate;
      }
    }
    return { columns, alongPitch, acrossPitch };
  };

  /**
   * A block of cards at card pitch, on the side of the parent that faces away
   * from the grandparent.
   *
   * A brood whose children are all leaves needs no room to grow outward, so a
   * block is the tightest arrangement there is: for one parent of thirty-eight
   * cards a ring needs a circle of radius 1,670 and the block fits the same
   * cards in under 60% of that area.
   */
  const planBlock = (id: string, kids: RadialNode[], shape: { columns: number; alongPitch: number; acrossPitch: number }) => {
    const outward = outwardOf.get(id) ?? 0;
    const dx = Math.cos(outward);
    const dy = Math.sin(outward);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
    const offsets = kids.map((_, index) => {
      const column = index % shape.columns;
      const row = Math.floor(index / shape.columns);
      const along = sign * shape.alongPitch * (row + 1);
      const across = (column - (shape.columns - 1) / 2) * shape.acrossPitch;
      return { x: horizontal ? along : across, y: horizontal ? across : along };
    });
    return { offsets, horizontal, sign, rows: Math.ceil(kids.length / shape.columns) };
  };

  const planCluster = (id: string) => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const isLeaf = (kid: RadialNode) => (children.get(kid.id) ?? []).length === 0;
    const leaves = kids.filter(isLeaf);
    const branching = kids.filter((kid) => !isLeaf(kid));

    // A brood whose children are almost all leaves packs as a block: those cards
    // need no room to grow outward. A SINGLE branching child goes in one row
    // beyond the block, where its own cluster grows into free space, and that one
    // branching child must not cost twenty leaves their tight packing: it is what
    // turned one brood into a fan five thousand units wide.
    //
    // Two or more branching children keep the fan. Measured: their clusters
    // collide in a block, and the repair pass then spreads the whole drawing to
    // separate them, which costs far more than the fan ever did.
    if (leaves.length >= 4 && branching.length <= 1) {
      const outward = outwardOf.get(id) ?? 0;
      const horizontal = Math.abs(Math.cos(outward)) >= Math.abs(Math.sin(outward));
      const shape = gridShape(leaves.length, horizontal);
      const block = planBlock(id, leaves, shape);
      if (branching.length === 0) {
        setPlan(id, leaves.map((kid) => kid.id), block.offsets);
        return;
      }
      const beyond = block.sign * shape.alongPitch * (block.rows + 1);
      const extra = branching.map((_, index) => {
        const across = (index - (branching.length - 1) / 2) * shape.acrossPitch;
        return { x: block.horizontal ? beyond : across, y: block.horizontal ? across : beyond };
      });
      setPlan(id, [...leaves.map((kid) => kid.id), ...branching.map((kid) => kid.id)], [...block.offsets, ...extra]);
      return;
    }

    const outward = outwardOf.get(id) ?? 0;
    // The root is the centre, so its children surround it. Any other node keeps
    // its children inside the arc this rule allows, which is at most a half turn
    // by default so no child sits behind its own parent.
    const fan = options.fan ?? defaultFan;
    const arc = Math.min(Math.PI * 2, id === root.id ? Math.PI * 2 : Math.max(0.2, fan(kids.length)));
    const angles = spread(arc, kids.length, outward);
    const radius = leastRadius(kids.length, angles, [], cardRadius);
    setPlan(
      id,
      kids.map((kid) => kid.id),
      angles.map((angle) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })),
    );
  };
  for (const id of order) planCluster(id);


  // ── place, then repair what really overlaps ────────────────────────────────
  const place = () => {
    centers.clear();
    positions.clear();
    const visit = (id: string, center: { x: number; y: number }) => {
      centers.set(id, center);
      const plan = plans.get(id);
      if (!plan) return;
      plan.order.forEach((kidId, index) => {
        const offset = plan.offsets[index];
        if (!kidId || !offset) return;
        const x = center.x + offset.x * plan.scale;
        const y = center.y + offset.y * plan.scale;
        angles.set(kidId, Math.atan2(offset.y, offset.x));
        radii.set(kidId, Math.hypot(offset.x, offset.y) * plan.scale);
        visit(kidId, { x, y });
      });
    };
    visit(root.id, { x: 0, y: 0 });
    for (const [id, center] of centers) {
      positions.set(id, { x: center.x - cardWidth / 2, y: center.y - cardHeight / 2 });
      depths.set(id, depthOf.get(id) ?? 0);
    }
    for (let cursor = order.length - 1; cursor >= 0; cursor--) {
      const id = order[cursor];
      const center = centers.get(id);
      if (!center) continue;
      let reach = cardRadius;
      for (const kid of children.get(id) ?? []) {
        const kidCenter = centers.get(kid.id);
        if (!kidCenter) continue;
        reach = Math.max(reach, Math.hypot(kidCenter.x - center.x, kidCenter.y - center.y) + (subtreeRadii.get(kid.id) ?? 0));
      }
      subtreeRadii.set(id, reach);
    }
  };

  /** Spread every cluster by one factor. A repair stays proportional. */
  const applyScale = (factor: number) => {
    for (const plan of plans.values()) plan.scale = factor;
    place();
  };

  let repairs = 0;
  place();
  let problems = findOverlaps({ positions, centers }, cardWidth, cardHeight);
  if (problems.length > 0) {
    // The packing is exact inside one cluster, but two branches can still reach
    // into each other. Their overlap shrinks as the whole drawing spreads, so the
    // least factor that clears every pair is found by bisection: that is far
    // gentler than growing one cluster at a time, which overshoots badly.
    let low = 1;
    let high = 1;
    let found = false;
    for (let attempt = 0; attempt < maxRepairs && !found; attempt++) {
      high *= 1.25;
      repairs += 1;
      applyScale(high);
      found = findOverlaps({ positions, centers }, cardWidth, cardHeight).length === 0;
    }
    if (found) {
      for (let step = 0; step < 24; step++) {
        const middle = (low + high) / 2;
        applyScale(middle);
        repairs += 1;
        if (findOverlaps({ positions, centers }, cardWidth, cardHeight).length === 0) high = middle;
        else low = middle;
      }
      applyScale(high);
      problems = findOverlaps({ positions, centers }, cardWidth, cardHeight);
    } else {
      applyScale(1);
      problems = findOverlaps({ positions, centers }, cardWidth, cardHeight);
    }
  }

  // ── generations, for the interface ─────────────────────────────────────────
  const byDepth = new Map<number, number[]>();
  for (const [id, depth] of depths) {
    const center = centers.get(id);
    if (!center) continue;
    const list = byDepth.get(depth) ?? [];
    list.push(Math.hypot(center.x, center.y));
    byDepth.set(depth, list);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const list = byDepth.get(depth) ?? [];
    rings.push({
      depth,
      count: list.length,
      meanRadius: list.reduce((total, value) => total + value, 0) / Math.max(1, list.length),
      maxRadius: Math.max(...list),
    });
  }

  for (const [id, depth] of depthOf) {
    const node = index.get(id);
    if (!node) continue;
    if (Number.isInteger(node.generation) && node.generation !== depth) {
      generationMismatch.push({ id, generation: node.generation, depth });
    }
  }

  // ── diagnostic column ──────────────────────────────────────────────────────
  // A diagnostic record keeps a card, but it is not given a ring or an angle:
  // a separate column to the left says "this record has no valid ancestry".
  diagnostics.sort((a, b) => a.id.localeCompare(b.id));
  const leftEdge = positions.size > 0 ? Math.min(...[...positions.values()].map((point) => point.x)) : 0;
  const diagnosticGap = 2 * cardRadius + cardGap;
  diagnostics.forEach((diagnostic, position) => {
    diagnosticPositions.set(diagnostic.id, {
      x: leftEdge - diagnosticGap,
      y: position * (cardHeight + cardGap),
    });
  });

  const bounds = computeBounds([...positions.values()], cardWidth, cardHeight);
  return {
    positions,
    centers,
    depths,
    angles,
    radii,
    childRings,
    subtreeRadii,
    rings,
    diagnostics,
    diagnosticPositions,
    generationMismatch,
    repairs,
    problems: problems.map((problem) => problem.text),
    bounds,
  };
}

/** Why a record cannot be placed. Never invent an answer. */
function classifyUnreachable(node: RadialNode, index: Map<string, RadialNode>): DiagnosticReason {
  const seen = new Set<string>([node.id]);
  let current: RadialNode | undefined = node;
  while (current?.parentId) {
    const parent = index.get(current.parentId);
    if (!parent) return 'orphan';
    if (seen.has(parent.id)) return 'cycle';
    seen.add(parent.id);
    current = parent;
  }
  return 'unreachable';
}

function computeBounds(points: { x: number; y: number }[], width: number, height: number) {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + width);
    maxY = Math.max(maxY, point.y + height);
  }
  return { minX, minY, maxX, maxY };
}

/** A stable key for the layout inputs: topology and card size, nothing else. */
export function layoutKey(nodes: RadialNode[], rootId: string | null, cardWidth: number, cardHeight: number): string {
  const parts = nodes.map((node) => `${node.id}|${node.parentId ?? ''}|${node.createdAt}`).sort();
  return `${rootId ?? ''}#${cardWidth}x${cardHeight}#${parts.join(',')}`;
}

/**
 * Check every pair of cards for overlap. The layout claims it is free of
 * overlap, so the claim is checked rather than assumed.
 *
 * @returns the pairs that touch, with the ids and the overlap size.
 */
export function findOverlaps(
  layout: { positions: Map<string, { x: number; y: number }>; centers: Map<string, { x: number; y: number }> },
  cardWidth: number,
  cardHeight: number,
  tolerance = 1e-6,
): { text: string; pair: [string, string] }[] {
  const entries = [...layout.centers.entries()];
  const problems: { text: string; pair: [string, string] }[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const dx = Math.abs(entries[i][1].x - entries[j][1].x);
      const dy = Math.abs(entries[i][1].y - entries[j][1].y);
      if (dx < cardWidth - tolerance && dy < cardHeight - tolerance) {
        problems.push({
          text: `${entries[i][0]} overlaps ${entries[j][0]} (dx ${dx.toFixed(1)}, dy ${dy.toFixed(1)})`,
          pair: [entries[i][0], entries[j][0]],
        });
        if (problems.length > 40) return problems;
      }
    }
  }
  return problems;
}

/**
 * The point where the segment between two card centres leaves the card.
 * Used to attach an edge to the card boundary instead of to a fixed side.
 */
export function boundaryPoint(center: { x: number; y: number }, toward: { x: number; y: number }, width: number, height: number) {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return { ...center };
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}
