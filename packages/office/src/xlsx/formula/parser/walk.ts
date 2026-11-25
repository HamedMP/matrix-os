/** Walking and rebuilding syntax trees. */

import type { FormulaAst, NameNode, ReferenceNode } from "../../../api/formula.js";
import type { ExtendedAst } from "./ast.js";

/** Calls `visit` for every node, parents before children, in source order. */
export function visitNodes(ast: ExtendedAst, visit: (node: ExtendedAst) => void): void {
  visit(ast);
  switch (ast.type) {
    case "unary":
      visitNodes(ast.operand, visit);
      break;
    case "binary":
    case "refop":
      visitNodes(ast.left, visit);
      visitNodes(ast.right, visit);
      break;
    case "call":
      for (const arg of ast.args) visitNodes(arg, visit);
      break;
    case "array":
      for (const row of ast.rows) for (const cell of row) visitNodes(cell, visit);
      break;
    case "paren":
      visitNodes(ast.inner, visit);
      break;
    default:
      break;
  }
}

/**
 * Every cell, range and name node in source order. A reference across a span
 * of sheets (`ref3d`) is not listed; find those with {@link visitNodes}.
 */
export function collectReferences(ast: ExtendedAst): Array<ReferenceNode | NameNode> {
  const found: Array<ReferenceNode | NameNode> = [];
  visitNodes(ast, (node) => {
    if (node.type === "cell" || node.type === "range" || node.type === "name") found.push(node);
  });
  return found;
}

/** Upper-case names of the functions a formula calls, each once, in source order. */
export function collectFunctionNames(ast: ExtendedAst): string[] {
  const names: string[] = [];
  visitNodes(ast, (node) => {
    if (node.type === "call" && !names.includes(node.name)) names.push(node.name);
  });
  return names;
}

function mapList(list: readonly ExtendedAst[], replace: (node: ExtendedAst) => ExtendedAst | null): ExtendedAst[] | null {
  let changed: ExtendedAst[] | null = null;
  for (let i = 0; i < list.length; i += 1) {
    const before = list[i] as ExtendedAst;
    const after = transformNodes(before, replace);
    if (after !== before && changed === null) changed = list.slice();
    if (changed !== null) changed[i] = after;
  }
  return changed;
}

/**
 * Rebuilds a tree. `replace` is called for every node, parents first: a
 * node it returns takes the place of the original and is not walked into;
 * null keeps the node and walks into its children. Parts that do not change
 * are shared with the original, and an unchanged tree is returned as it is.
 */
export function transformNodes(ast: ExtendedAst, replace: (node: ExtendedAst) => ExtendedAst | null): ExtendedAst {
  const replaced = replace(ast);
  if (replaced !== null) return replaced;
  switch (ast.type) {
    case "unary": {
      const operand = transformNodes(ast.operand, replace);
      return operand === ast.operand ? ast : { ...ast, operand };
    }
    case "binary":
    case "refop": {
      const left = transformNodes(ast.left, replace);
      const right = transformNodes(ast.right, replace);
      return left === ast.left && right === ast.right ? ast : { ...ast, left, right };
    }
    case "call": {
      const args = mapList(ast.args, replace);
      return args === null ? ast : { ...ast, args };
    }
    case "array": {
      let rows: ExtendedAst[][] | null = null;
      for (let i = 0; i < ast.rows.length; i += 1) {
        const row = mapList(ast.rows[i] as ExtendedAst[], replace);
        if (row === null) continue;
        if (rows === null) rows = ast.rows.slice();
        rows[i] = row;
      }
      return rows === null ? ast : { ...ast, rows };
    }
    case "paren": {
      const inner = transformNodes(ast.inner, replace);
      return inner === ast.inner ? ast : { ...ast, inner };
    }
    default:
      return ast;
  }
}

/**
 * Returns a copy of the tree with each cell and range node replaced by what
 * `map` returns: the same node to keep it, an error node with `#REF!` for a
 * deleted target. An unchanged tree is returned as it is, so
 * `mapReferences(ast, f) === ast` tells that nothing moved. A reference
 * across a span of sheets is left alone.
 */
export function mapReferences(ast: FormulaAst, map: (node: ReferenceNode) => FormulaAst): FormulaAst;
export function mapReferences(ast: ExtendedAst, map: (node: ReferenceNode) => ExtendedAst): ExtendedAst;
export function mapReferences(ast: ExtendedAst, map: (node: ReferenceNode) => ExtendedAst): ExtendedAst {
  return transformNodes(ast, (node) => (node.type === "cell" || node.type === "range" ? map(node) : null));
}
