/**
 * The order in which formula cells are calculated.
 *
 * Nothing here recurses: the order is found with an explicit stack, so a
 * chain of a million cells cannot overflow the call stack.
 */

import type { CellRange } from "../../api/xlsx.js";
import type { CalcGraph, CalcNode, Dep } from "./calc-graph.js";

function lowerBound(list: readonly CalcNode[], row: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((list[mid] as CalcNode).row < row) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Walks the formula cells a node reads, one at a time, without building a list of them. */
export class Precedents {
  private depIndex = 0;
  private lists: CalcNode[][] = [];
  private listIndex = 0;
  private list: CalcNode[] | null = null;
  private position = 0;
  private lastRow = 0;
  /** The rectangle whose array formulas are being listed, and how far the listing got. */
  private spillDep: Dep | null = null;
  private spillIndex = 0;

  constructor(
    private readonly graph: CalcGraph,
    private readonly deps: readonly Dep[],
  ) {}

  next(): CalcNode | null {
    for (;;) {
      const list = this.list;
      if (list !== null) {
        const candidate = list[this.position];
        if (candidate !== undefined && candidate.row <= this.lastRow) {
          this.position++;
          return candidate;
        }
        this.list = null;
      }
      if (this.listIndex < this.lists.length) {
        const nextList = this.lists[this.listIndex++] as CalcNode[];
        this.list = nextList;
        this.position = lowerBound(nextList, (this.deps[this.depIndex - 1] as Dep).r1);
        continue;
      }
      const spillDep = this.spillDep;
      if (spillDep !== null) {
        // An array formula is read through every cell of the range it fills.
        const spills = this.graph.spills;
        while (this.spillIndex < spills.length) {
          const node = spills[this.spillIndex++] as CalcNode;
          const area = node.spill as CellRange;
          if (
            node.sheet === spillDep.sheet &&
            area.start.row <= spillDep.r2 &&
            area.end.row >= spillDep.r1 &&
            area.start.col <= spillDep.c2 &&
            area.end.col >= spillDep.c1
          ) {
            return node;
          }
        }
        this.spillDep = null;
      }
      const dep = this.deps[this.depIndex++];
      if (dep === undefined) return null;
      if (this.graph.spills.length > 0) {
        this.spillDep = dep;
        this.spillIndex = 0;
      }
      this.lists = [];
      this.listIndex = 0;
      this.lastRow = dep.r2;
      const columns = this.graph.columns.get(dep.sheet);
      if (columns === undefined) continue;
      if (dep.c2 - dep.c1 + 1 <= columns.size) {
        for (let col = dep.c1; col <= dep.c2; col++) {
          const found = columns.get(col);
          if (found !== undefined) this.lists.push(found);
        }
      } else {
        for (const [col, found] of columns) if (col >= dep.c1 && col <= dep.c2) this.lists.push(found);
      }
    }
  }
}

/**
 * Orders the nodes so that each comes after the formula cells it reads, and
 * flags every node of a circular reference (a strongly connected component
 * of more than one node, or a formula that reads its own cell).
 *
 * Formulas that pick their cells at run time are started last, so the
 * formula cells they may read are, as far as the names in the formulas
 * tell, calculated before them.
 *
 * A node at the end of a chain deeper than `maxDepth`, and every node that
 * reads one, is left out of the order and returned in `blocked`; the walk
 * goes on with the other nodes.
 *
 * `depth` is the deepest the walk went. The walk is the same for every bound
 * at least that deep, so the order also holds for those bounds.
 */
export function orderGraph(graph: CalcGraph, maxDepth: number): { order: CalcNode[]; blocked: CalcNode[]; depth: number } {
  for (const node of graph.nodes) {
    node.index = -1;
    node.onStack = false;
    node.circular = false;
    node.blocked = false;
  }
  const order: CalcNode[] = [];
  const blocked: CalcNode[] = [];
  const stack: CalcNode[] = [];
  const walkers: Precedents[] = [];
  const component: CalcNode[] = [];
  let counter = 0;
  let depth = 0;
  const enter = (node: CalcNode): void => {
    node.index = counter;
    node.low = counter++;
    node.onStack = true;
    component.push(node);
    stack.push(node);
    walkers.push(new Precedents(graph, node.deps));
    if (stack.length > depth) depth = stack.length;
  };
  const walk = (root: CalcNode): void => {
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as CalcNode;
      const next = (walkers[walkers.length - 1] as Precedents).next();
      if (next === null) {
        if (top.low === top.index) {
          // `top` closes a component: everything above it on the component stack belongs to it.
          const first = component.lastIndexOf(top);
          if (component.length - first > 1) for (let i = first; i < component.length; i++) (component[i] as CalcNode).circular = true;
          for (let i = first; i < component.length; i++) (component[i] as CalcNode).onStack = false;
          component.length = first;
        }
        if (top.blocked) blocked.push(top);
        else order.push(top);
        stack.pop();
        walkers.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined) {
          if (top.low < parent.low) parent.low = top.low;
          if (top.blocked) parent.blocked = true;
        }
      } else if (next.index === -1) {
        // Too deep: `next` is started on its own later, and what reads it waits for another run.
        if (stack.length >= maxDepth) top.blocked = true;
        else enter(next);
      } else if (next.onStack) {
        if (next === top) top.circular = true;
        if (next.index < top.low) top.low = next.index;
      } else if (next.blocked) {
        top.blocked = true;
      }
    }
  };
  for (const root of graph.nodes) if (root.index === -1 && !root.dynamic) walk(root);
  for (const root of graph.nodes) if (root.index === -1) walk(root);
  return { order, blocked, depth };
}
