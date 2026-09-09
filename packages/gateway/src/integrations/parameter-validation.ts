import type { ServiceAction } from "./types.js";

export type ActionParamValidationResult = { valid: true } | {
  valid: false;
  missing: string[];
  typeErrors: string[];
  valueErrors?: string[];
};

export function validateActionParams(
  actionDef: ServiceAction,
  params: Record<string, unknown> | undefined,
): ActionParamValidationResult {
  const missing: string[] = [];
  const typeErrors: string[] = [];
  const valueErrors: string[] = [];

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
      } else if (expectedType === "string" && typeof value === "string") {
        if (def.minLength !== undefined && value.length < def.minLength) {
          valueErrors.push(`${name}: must contain at least ${def.minLength} character${def.minLength === 1 ? "" : "s"}`);
        }
        if (def.maxLength !== undefined && value.length > def.maxLength) {
          valueErrors.push(`${name}: must contain at most ${def.maxLength} characters`);
        }
        if (def.pattern !== undefined && !new RegExp(def.pattern, "u").test(value)) {
          valueErrors.push(`${name}: ${def.patternMessage ?? "has an invalid format"}`);
        }
      } else if (expectedType === "number" && typeof value === "number") {
        if (!Number.isFinite(value)) {
          valueErrors.push(`${name}: must be a finite number`);
        } else {
          if (def.minimum !== undefined && value < def.minimum) {
            valueErrors.push(`${name}: must be at least ${def.minimum}`);
          }
          if (def.maximum !== undefined && value > def.maximum) {
            valueErrors.push(`${name}: must be at most ${def.maximum}`);
          }
        }
      }
    }
  }

  if (missing.length > 0 || typeErrors.length > 0 || valueErrors.length > 0) {
    return {
      valid: false,
      missing,
      typeErrors,
      ...(valueErrors.length > 0 ? { valueErrors } : {}),
    };
  }
  if (actionDef.paramsSchema && !actionDef.paramsSchema.safeParse(params ?? {}).success) {
    // Keep arbitrary caller keys and values out of client-facing schema errors.
    return { valid: false, missing: [], typeErrors: ["params: invalid value"] };
  }
  return { valid: true };
}

export function formatActionParamValidationError(
  validation: Exclude<ActionParamValidationResult, { valid: true }>,
): string {
  const parts: string[] = [];
  if (validation.missing.length > 0) {
    parts.push(`Missing required params: ${validation.missing.join(", ")}`);
  }
  if (validation.typeErrors.length > 0) {
    parts.push(`Invalid param type: ${validation.typeErrors.join("; ")}`);
  }
  if (validation.valueErrors?.length) {
    parts.push(`Invalid param value: ${validation.valueErrors.join("; ")}`);
  }
  return parts.join(". ");
}
