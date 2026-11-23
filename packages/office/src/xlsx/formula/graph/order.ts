/**
 * Calculation order of a set of cells.
 *
 * `successors(n)` lists the cells that read `n`, so `n` must be calculated
 * before them. The result lists every cell once, precedents first. Cells
 * that read each other in a circle cannot be ordered: they are reported in
 * `circular` and keep a place in the order (before the cells that read them).
 *
 * Nothing here recurses, so a dependency chain of any length is fine.
 */

export interface CalculationOrder<N> {
  /** Every node once, precedents before dependents. */
  order: N[];
  /** The nodes that are part of a circular reference. */
  circular: Set<N>;
  /** Length of the longest chain of precedents that ends at each node; 1 for a node without precedents in the set. */
  depth: Map<N, number>;
}

/** Strongly connected components of the nodes, each list in the order found, components in reverse dependency order. */
function components<N>(nodes: readonly N[], members: ReadonlySet<N>, successors: (node: N) => readonly N[]): N[][] {
  // Bounded by the number of nodes given.
  const index = new Map<N, number>();
  const low = new Map<N, number>();
  const onStack = new Set<N>();
  const stack: N[] = [];
  const found: N[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: N; next: readonly N[]; at: number }> = [];
    const open = (node: N): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: successors(node), at: 0 });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: N; next: readonly N[]; at: number };
      if (frame.at < frame.next.length) {
        const target = frame.next[frame.at] as N;
        frame.at += 1;
        if (!members.has(target)) continue;
        if (!index.has(target)) open(target);
        else if (onStack.has(target)) low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(target) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: N[] = [];
      for (;;) {
        const member = stack.pop() as N;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      found.push(component);
    }
  }
  return found;
}

export function calculationOrder<N>(nodes: readonly N[], successors: (node: N) => readonly N[]): CalculationOrder<N> {
  const members = new Set<N>(nodes);
  const waiting = new Map<N, number>();
  for (const node of members) waiting.set(node, 0);
  for (const node of members) {
    for (const next of successors(node)) {
      if (members.has(next)) waiting.set(next, (waiting.get(next) as number) + 1);
    }
  }
  const order: N[] = [];
  const circular = new Set<N>();
  for (const node of members) {
    if (waiting.get(node) === 0) order.push(node);
  }
  for (let i = 0; i < order.length; i += 1) {
    for (const next of successors(order[i] as N)) {
      if (!members.has(next)) continue;
      const left = (waiting.get(next) as number) - 1;
      waiting.set(next, left);
      if (left === 0) order.push(next);
    }
  }
  if (order.length < members.size) {
    // What is left reads a circle, directly or through other cells.
    const placed = new Set<N>(order);
    const rest: N[] = [];
    for (const node of members) {
      if (!placed.has(node)) rest.push(node);
    }
    const restSet = new Set<N>(rest);
    const found = components(rest, restSet, successors);
    for (let i = found.length - 1; i >= 0; i -= 1) {
      const component = found[i] as N[];
      const only = component[0] as N;
      const circle = component.length > 1 || successors(only).includes(only);
      for (let k = component.length - 1; k >= 0; k -= 1) {
        const node = component[k] as N;
        if (circle) circular.add(node);
        order.push(node);
      }
    }
  }
  const depth = new Map<N, number>();
  const done = new Set<N>();
  for (const node of order) {
    const own = depth.get(node) ?? 1;
    depth.set(node, own);
    done.add(node);
    for (const next of successors(node)) {
      if (!members.has(next) || done.has(next)) continue;
      if ((depth.get(next) ?? 1) < own + 1) depth.set(next, own + 1);
    }
  }
  return { order, circular, depth };
}
