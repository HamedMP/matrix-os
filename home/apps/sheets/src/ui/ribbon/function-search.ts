/** Searching the engine's function registry for the function picker. */
import { createFunctionCatalog, type FunctionCatalog, type FunctionHint } from "../../grid";

/** Most functions listed at once; the search narrows the rest. */
export const MAX_LISTED_FUNCTIONS = 60;

let catalog: FunctionCatalog | null = null;

function functionCatalog(): FunctionCatalog {
  catalog ??= createFunctionCatalog();
  return catalog;
}

/** Functions whose name starts with the query first, then those whose name or summary contains it. */
export function searchFunctions(query: string, limit = MAX_LISTED_FUNCTIONS): FunctionHint[] {
  const all = functionCatalog();
  const wanted = query.trim().toUpperCase();
  const starts: FunctionHint[] = [];
  const contains: FunctionHint[] = [];
  for (const name of all.names) {
    const hint = all.hint(name);
    if (hint === null) continue;
    if (wanted === "" || name.startsWith(wanted)) starts.push(hint);
    else if (name.includes(wanted) || hint.summary.toUpperCase().includes(wanted)) contains.push(hint);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/** How many functions the engine calculates. */
export function functionCount(): number {
  return functionCatalog().names.length;
}
