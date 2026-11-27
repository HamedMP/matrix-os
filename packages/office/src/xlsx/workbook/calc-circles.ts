/**
 * Circles that formulas close at run time.
 *
 * The order (`calc-order.ts`) finds the circles the formula text names. A
 * formula that picks its cells at run time (OFFSET, INDIRECT) can close one
 * the text does not name, and when the values in it stop moving a run sees
 * nothing more to calculate. After such a run this walks the formula cells
 * from the ones that picked their cells, following both the cells each
 * formula names and the cells it read on its last calculation, and returns
 * the cells of every circle it meets (a strongly connected component of
 * more than one cell). Nothing here recurses.
 *
 * A formula that read more rectangles than are kept adds no run-time reads:
 * what it read is not known. The walk takes at most {@link MAX_CIRCLE_STEPS}
 * steps; past it only the circles it finished are returned.
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

function edgesOf(node: CalcNode): readonly Dep[] {
  if (!node.dynamic || node.reads === null || node.readsAll || node.reads.length === 0) return node.deps;
  return node.deps.length === 0 ? node.reads : [...node.deps, ...node.reads];
}

/**
 * The cells of the circles reachable from `roots` through what formulas name and what they read at run time.
 * Cells the order already marks as circular and cells it left out are not entered.
 */
export function findRunCircles(graph: CalcGraph, roots: Iterable<CalcNode>, maxSteps = MAX_CIRCLE_STEPS): CalcNode[] {
  const visits = new Map<CalcNode, Visit>();
  const found: CalcNode[] = [];
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
    if (steps >= maxSteps) return found;
    enter(root);
    while (stack.length > 0) {
      // A walk cut short could close a component before all of it is seen; the ones closed so far are whole.
      if (steps >= maxSteps) return found;
      const top = stack[stack.length - 1] as CalcNode;
      const visit = visits.get(top) as Visit;
      const next = (walkers[walkers.length - 1] as Precedents).next();
      if (next === null) {
        if (visit.low === visit.index) {
          const first = component.lastIndexOf(top);
          if (component.length - first > 1) for (let i = first; i < component.length; i++) found.push(component[i] as CalcNode);
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
  return found;
}
