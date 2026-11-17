import { CanonicalChatSafeErrorSchema } from "@matrix-os/contracts";
import { types } from "node:util";
import { CanonicalChatOrchestrationError } from "../chat/orchestration-errors.js";

/** Fixed categories and a validated code only; never inspect exception text or getters. */
export function routineOutcomeDiagnostic(error: unknown) {
  if (types.isProxy(error) || !types.isNativeError(error)) return { errorType: "UnknownError" };
  // Direct prototype identity avoids traversing caller-controlled prototype chains.
  if (Object.getPrototypeOf(error) !== CanonicalChatOrchestrationError.prototype) return { errorType: "Error" };
  const safeError: unknown = Object.getOwnPropertyDescriptor(error, "safeError")?.value;
  const rawCode: unknown = safeError !== null && typeof safeError === "object" && !types.isProxy(safeError) && !Array.isArray(safeError)
    ? Object.getOwnPropertyDescriptor(safeError, "code")?.value : undefined;
  const code = typeof rawCode === "string" ? CanonicalChatSafeErrorSchema.shape.code.safeParse(rawCode) : undefined;
  return { errorType: "CanonicalChatOrchestrationError", ...(code?.success ? { code: code.data } : {}) };
}
