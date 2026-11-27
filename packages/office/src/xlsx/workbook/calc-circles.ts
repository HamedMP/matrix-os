/**
 * Circles that formulas close at run time.
 *
 * The order (`calc-order.ts`) finds the circles the formula text names. A
 * formula that picks its cells at run time (OFFSET, INDIRECT) can close one
 * the text does not name, and when the values in it stop moving a run sees
 * nothing more to calculate. After such a run this walks the formula cells
 * from the ones that picked their cells, following the cells each formula
 * read on its last calculation, and returns the cells of every circle it
 * meets (a strongly connected component of more than one cell). What a
 * formula names but did not read, such as the branch of an IF it did not
 * take, is no part of a circle. Nothing here recurses.
 *
 * A formula not calculated since its cells were last gathered has no reads
 * yet: the walk follows what it names, and a circle through it is returned
 * as unread instead, for the run to calculate those formulas and look again.
 * A formula that read more rectangles than are kept leads nowhere: what it
 * read is not known, and a circle missed is less harm than a value wrongly
 * replaced by #REF!. The walk takes at most {@link MAX_CIRCLE_STEPS} steps;
 * past it only the circles it finished are returned.
 */

import type { CalcGraph, CalcNode, Dep } from "./calc-graph.js";
import { Precedents } from "./calc-order.js";

/** Cells entered plus precedents looked at in one walk. */
export const MAX_CIRCLE_STEPS = 1_000_000;

interface Visit {
  index: number;
  low: number;
  onStack: boolean;
}

const NOWHERE: readonly Dep[] = [];

function edgesOf(node: CalcNode): readonly Dep[] {
  if (node.reads === null) return node.deps;
  return node.readsAll ? NOWHERE : node.reads;
}

export interface RunCircles {
  /** The cells of the circles found, every one of them closed by what its formulas read. */
  circles: CalcNode[];
  /** Formulas without reads that sit in a circle of what they name: calculated, they may close it or not. */
  unread: CalcNode[];
}

/** Adds the component from `first` on to `found`, or its formulas without reads to `unread` when it has any. */
function close(component: readonly CalcNode[], first: number, found: CalcNode[], unread: CalcNode[]): void {
  let missing = false;
  for (let i = first; i < component.length; i++) {
    const node = component[i] as CalcNode;
    if (node.reads !== null) continue;
    missing = true;
    unread.push(node);
  }
  if (!missing) for (let i = first; i < component.length; i++) found.push(component[i] as CalcNode);
}

/**
 * The circles reachable from `roots` through what formulas read on their last calculation.
 * Cells the order already marks as circular and cells it left out are not entered.
 */
export function findRunCircles(graph: CalcGraph, roots: Iterable<CalcNode>, maxSteps = MAX_CIRCLE_STEPS): RunCircles {
  const visits = new Map<CalcNode, Visit>();
  const found: CalcNode[] = [];
  const unread: CalcNode[] = [];
  const result: RunCircles = { circles: found, unread };
  const stack: CalcNode[] = [];
  const walkers: Precedents[] = [];
  const component: CalcNode[] = [];
  let counter = 0;
  let steps = 0;
  const skipped = (node: CalcNode): boolean => node.circular || node.blocked;
  const enter = (node: CalcNode): void => {
    visits.set(node, { index: counter, low: counter, onStack: true });
    counter++;
    steps++;
    component.push(node);
    stack.push(node);
    walkers.push(new Precedents(graph, edgesOf(node)));
  };
  for (const root of roots) {
    if (visits.has(root) || skipped(root)) continue;
    if (steps >= maxSteps) return result;
    enter(root);
    while (stack.length > 0) {
      // A walk cut short could close a component before all of it is seen; the ones closed so far are whole.
      if (steps >= maxSteps) return result;
      const top = stack[stack.length - 1] as CalcNode;
      const visit = visits.get(top) as Visit;
      const next = (walkers[walkers.length - 1] as Precedents).next();
      if (next === null) {
        if (visit.low === visit.index) {
          const first = component.lastIndexOf(top);
          if (component.length - first > 1) close(component, first, found, unread);
          for (let i = first; i < component.length; i++) (visits.get(component[i] as CalcNode) as Visit).onStack = false;
          component.length = first;
        }
        stack.pop();
        walkers.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined) {
          const above = visits.get(parent) as Visit;
          if (visit.low < above.low) above.low = visit.low;
        }
        continue;
      }
      steps++;
      if (skipped(next)) continue;
      const seen = visits.get(next);
      if (seen === undefined) enter(next);
      else if (seen.onStack && seen.index < visit.low) visit.low = seen.index;
    }
  }
  return result;
}
