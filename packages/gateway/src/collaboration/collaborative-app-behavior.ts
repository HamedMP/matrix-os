import { parse } from "acorn";
import { BridgeQueryBodySchema } from "../app-db-contracts.js";

import type { CollaborativeAppBuildBehavior } from "./collaborative-app-readiness.js";

type AstNode = { type: string; [key: string]: unknown };
type Method = "query" | "mutate" | "onChange";

const READ_ACTIONS = new Set(["find", "findOne", "count"]);
const WRITE_ACTIONS = new Set(["insert", "bulkInsert", "update", "compareAndSwap", "bulkUpdate", "delete"]);
const METHODS = new Set<Method>(["query", "mutate", "onChange"]);
const MAX_NODES = 200_000;
const MAX_ALIASES = 32;
const MAX_FUNCTIONS = 4_096;

function node(value: unknown): AstNode | null {
  return value && typeof value === "object" && typeof (value as AstNode).type === "string"
    ? value as AstNode : null;
}

function identifier(value: unknown): string | null {
  const current = node(value);
  return current?.type === "Identifier" && typeof current.name === "string" ? current.name : null;
}

function propertyName(value: unknown): string | null {
  const current = node(value);
  if (!current) return null;
  if (current.type === "Identifier") return identifier(current);
  if (current.type === "Literal" && typeof current.value === "string") return current.value;
  return null;
}

function memberPath(value: unknown): string | null {
  const current = node(value);
  if (!current) return null;
  if (current.type === "ChainExpression") return memberPath(current.expression);
  if (current.type === "Identifier") return identifier(current);
  if (current.type !== "MemberExpression") return null;
  const base = memberPath(current.object);
  const property = propertyName(current.property);
  return base && property ? `${base}.${property}` : null;
}

function resolveValue(value: unknown, knownValues: Map<string, AstNode>, seen = new Set<string>()): AstNode | null {
  let current = node(value);
  while (current?.type === "Identifier") {
    const name = identifier(current);
    if (!name || seen.has(name)) return current;
    const known = knownValues.get(name);
    if (!known) return current;
    seen.add(name);
    current = known;
  }
  return current;
}

function arrayProbe(name: string): unknown {
  return name === "updates" ? { id: "probe", data: { value: "probe" } } : { value: "probe" };
}

function literalArray(value: AstNode, name: string, knownValues: Map<string, AstNode>, depth = 0): unknown[] {
  if (depth > 8) return [arrayProbe(name)];
  if (!Array.isArray(value.elements)) return [];
  const result: unknown[] = [];
  for (const entry of value.elements) {
    const item = node(entry);
    const resolved = resolveValue(item?.type === "SpreadElement" ? item.argument : item, knownValues);
    if (item?.type === "SpreadElement") {
      result.push(...(resolved?.type === "ArrayExpression"
        ? literalArray(resolved, name, knownValues, depth + 1) : [arrayProbe(name)]));
    } else if (resolved?.type === "ObjectExpression") {
      result.push(literalAction(resolved, knownValues));
    } else if (resolved?.type === "Literal") {
      result.push(resolved.value);
    } else {
      result.push(arrayProbe(name));
    }
  }
  return result;
}

function literalAction(value: unknown, knownValues: Map<string, AstNode>): Record<string, unknown> | null {
  const current = node(value);
  if (current?.type !== "ObjectExpression" || !Array.isArray(current.properties)) return null;
  const result: Record<string, unknown> = {};
  for (const entry of current.properties) {
    const property = node(entry);
    if (property?.type !== "Property" || property.computed) return null;
    const name = propertyName(property.key);
    if (!name) return null;
    const valueNode = node(property.value);
    if (valueNode?.type === "Literal") {
      result[name] = valueNode.value;
    } else if (valueNode?.type === "ObjectExpression") {
      const nested = literalAction(valueNode, knownValues);
      if (!nested) return null;
      result[name] = nested;
    } else if (valueNode?.type === "ArrayExpression") {
      result[name] = literalArray(valueNode, name, knownValues);
    } else if (name === "data" || name === "expectedPayload") {
      result[name] = { value: "probe" };
    } else {
      result[name] = "probe";
    }
  }
  return result;
}

function validAction(value: unknown, write: boolean, knownValues: Map<string, AstNode>): boolean {
  const action = literalAction(value, knownValues);
  if (!action || typeof action.action !== "string") return false;
  if (!(write ? WRITE_ACTIONS : READ_ACTIONS).has(action.action)) return false;
  return BridgeQueryBodySchema.safeParse({ ...action, app: "probe" }).success;
}

/** Counts only reachable calls in one loaded built script; this is a conservative static preflight. */
export function inspectBehaviorSource(source: string, signal: AbortSignal): CollaborativeAppBuildBehavior {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }) as unknown as AstNode;
  const behavior: CollaborativeAppBuildBehavior = { sharedRead: false, revisionedWrite: false, changeSignal: false };
  const bases = new Set(["MatrixOS.collaboration", "window.MatrixOS.collaboration", "globalThis.MatrixOS.collaboration"]);
  const methods = new Map<string, Method>();
  const functions = new Map<string, AstNode>();
  const knownValues = new Map<string, AstNode>();
  const activeFunctions = new Set<AstNode>();
  let visited = 0;

  const visit = (current: AstNode, depth: number): void => {
    if (++visited % 1024 === 0) signal.throwIfAborted();
    if (visited > MAX_NODES || depth > 64) throw new Error("Built app behavior inspection limit exceeded");
    if (current.type === "FunctionDeclaration") {
      const name = identifier(current.id);
      if (name && functions.size < MAX_FUNCTIONS) functions.set(name, current);
      return;
    }
    if (current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression"
      || current.type === "ClassDeclaration" || current.type === "ClassExpression") return;
    if (current.type === "VariableDeclarator") {
      const name = identifier(current.id);
      const init = node(current.init);
      if (name && init && ["ObjectExpression", "ArrayExpression", "Literal"].includes(init.type)
        && knownValues.size < MAX_FUNCTIONS) knownValues.set(name, init);
      if (name && init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")) {
        if (functions.size < MAX_FUNCTIONS) functions.set(name, init);
      } else if (name && init && bases.has(memberPath(init) ?? "") && bases.size < MAX_ALIASES) {
        bases.add(name);
      } else if (node(current.id)?.type === "ObjectPattern" && init && bases.has(memberPath(init) ?? "")) {
        const properties = node(current.id)?.properties;
        if (Array.isArray(properties)) for (const entry of properties) {
          const property = node(entry);
          const method = propertyName(property?.key);
          const local = identifier(property?.value);
          if (method && METHODS.has(method as Method) && local && methods.size < MAX_ALIASES) {
            methods.set(local, method as Method);
          }
        }
      }
    }
    if (current.type === "IfStatement" && node(current.test)?.type === "Literal") {
      const branch = node(current.test)?.value ? current.consequent : current.alternate;
      const selected = node(branch);
      if (selected) visit(selected, depth + 1);
      return;
    }
    if (current.type === "CallExpression") {
      const path = memberPath(current.callee);
      const local = identifier(current.callee);
      const method = local && methods.get(local)
        || (path && [...bases].find((base) => path === `${base}.query` || path === `${base}.mutate` || path === `${base}.onChange`)
          ? path.split(".").at(-1) as Method : null);
      const args = Array.isArray(current.arguments) ? current.arguments : [];
      if (method === "query" && validAction(args[0], false, knownValues)) behavior.sharedRead = true;
      if (method === "mutate" && args.length >= 2 && validAction(args[0], true, knownValues)) behavior.revisionedWrite = true;
      if (method === "onChange" && args.length > 0) behavior.changeSignal = true;
      const runFunction = (candidate: unknown): void => {
        const name = identifier(candidate);
        const called = name ? functions.get(name) : node(candidate);
        if (!called || !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(called.type)
          || activeFunctions.has(called)) return;
        activeFunctions.add(called);
        const body = node(called.body);
        if (body) visit(body, depth + 1);
        activeFunctions.delete(called);
      };
      runFunction(current.callee);
      // A rendered React component and its effect/event callbacks are reachable
      // from the entry module even when React invokes them after this call.
      if (path?.endsWith(".createElement") || path === "createElement"
        || path?.endsWith(".jsx") || path?.endsWith(".jsxs") || path === "jsx" || path === "jsxs") {
        runFunction(args[0]);
        const props = node(args[1]);
        if (props?.type === "ObjectExpression" && Array.isArray(props.properties)) {
          for (const entry of props.properties) {
            const property = node(entry);
            const key = propertyName(property?.key);
            if (key && /^on[A-Z]/.test(key)) runFunction(property?.value);
          }
        }
      }
      if (path?.endsWith(".useEffect") || path === "useEffect") runFunction(args[0]);
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const child of value) { const found = node(child); if (found) visit(found, depth + 1); }
      } else {
        const found = node(value);
        if (found) visit(found, depth + 1);
      }
    }
  };

  if (Array.isArray(ast.body)) {
    for (const statement of ast.body) {
      const declaration = node(statement);
      if (declaration?.type === "FunctionDeclaration") visit(declaration, 0);
    }
  }
  visit(ast, 0);
  return behavior;
}
