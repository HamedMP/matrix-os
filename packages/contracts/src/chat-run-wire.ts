import { z } from "zod/v4";

/** Run/action extensions are independent of message, metadata and SSE versions. */
export const ChatRunWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatRunWireVersion = z.infer<typeof ChatRunWireVersionSchema>;
export function chatRunVersionUrl(path: string): string {
  if (/[?&]runVersion=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}runVersion=1`;
}

/** Project validated envelopes only; never change repository/outbox authority. */
export function projectChatRunResponse<T>(value: T, version: ChatRunWireVersion): T {
  if (version === "1") return value;
  const object = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  const approval = (input: unknown): unknown => {
    if (!object(input) || !["approval_request", "approval.requested", "approval.resolved"].includes(String(input.type))) return input;
    const { argumentDigest: _argumentDigest, ...legacy } = input;
    return legacy;
  };
  const message = (input: unknown): unknown => !object(input) || !Array.isArray(input.parts) ? input
    : { ...input, parts: input.parts.map(approval) };
  function project(input: unknown, depth: number): unknown {
    if (depth > 4 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(item => project(item, depth + 1));
    const { runPolicy: _runPolicy, operations: _operations, granularity: _granularity, ...result } = input as Record<string, unknown>;
    if (object(result.capabilitySnapshot)) {
      const { approvalBinding: _approvalBinding, cancellation, ...capabilities } = result.capabilitySnapshot;
      // A legacy true advertises whole-run cancellation, never a tool-only stop.
      result.capabilitySnapshot = { ...capabilities, cancellation: cancellation === true || cancellation === "run" };
    }
    if (Array.isArray(result.activities)) result.activities = result.activities.map(approval);
    if (Array.isArray(result.messages)) result.messages = result.messages.map(message);
    if (result.message) result.message = message(result.message);
    if (object(result.messageDelta)) result.messageDelta = { ...result.messageDelta, message: message(result.messageDelta.message) };
    for (const key of ["record", "items", "content", "run", "runs", "queuedTurn", "queuedTurns"]) {
      if (key in result) result[key] = project(result[key], depth + 1);
    }
    return result;
  }
  return project(value, 0) as T;
}
