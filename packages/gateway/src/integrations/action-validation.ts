import type { ServiceAction } from "./types.js";

export function validateActionParams(
  actionDef: ServiceAction,
  params: Record<string, unknown> | undefined,
): { valid: true } | { valid: false; missing: string[]; typeErrors: string[] } {
  const missing: string[] = [];
  const typeErrors: string[] = [];

  for (const [name, def] of Object.entries(actionDef.params)) {
    const value = params?.[name];
    if (def.required && (value === undefined || value === null)) {
      missing.push(name);
      continue;
    }
    if (value !== undefined && value !== null) {
      const expectedType = def.type;
      const actualType = typeof value;
      if (expectedType === "string" && actualType !== "string") {
        typeErrors.push(`${name}: expected string, got ${actualType}`);
      } else if (expectedType === "number" && actualType !== "number") {
        typeErrors.push(`${name}: expected number, got ${actualType}`);
      } else if (expectedType === "boolean" && actualType !== "boolean") {
        typeErrors.push(`${name}: expected boolean, got ${actualType}`);
      } else if (expectedType === "object" && (actualType !== "object" || Array.isArray(value))) {
        typeErrors.push(`${name}: expected object, got ${actualType}`);
      } else if (expectedType === "array" && !Array.isArray(value)) {
        typeErrors.push(`${name}: expected array, got ${actualType}`);
      }
    }
  }

  if (missing.length > 0 || typeErrors.length > 0) {
    return { valid: false, missing, typeErrors };
  }
  if (actionDef.paramsSchema && !actionDef.paramsSchema.safeParse(params ?? {}).success) {
    // Do not expose Zod messages containing arbitrary keys or parameter values.
    return { valid: false, missing: [], typeErrors: ["params: invalid value"] };
  }
  return { valid: true };
}
