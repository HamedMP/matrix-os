/** Internal diagnostics contain fixed phases/codes, never native messages, arguments or identities. */
export type HermesRunStage = "ready" | "session_create" | "session_resume" | "session_model" | "cwd" | "yolo" | "browser_catalog" | "restricted_catalog" | "restricted_preflight" | "selected_route" | "prompt" | "run";
const METHODS = ["session.create", "session.resume", "session.cwd.set", "config.set", "prompt.submit", "session.interrupt", "session.steer", "approval.respond", "request.answer"] as const;
export class HermesGatewayRequestError extends Error {
  readonly name = "HermesGatewayRequestError";
  readonly method: string;
  readonly code: number | null;
  constructor(method: string, code: number) {
    super("Hermes gateway request failed");
    this.method = METHODS.includes(method as typeof METHODS[number]) ? method : "other";
    this.code = Number.isSafeInteger(code) && (code >= -32768 && code <= -32000 || code >= 4000 && code <= 5999) ? code : null;
  }
}
export class HermesNativeEventError extends Error {
  readonly name = "HermesNativeEventError";
  constructor() { super("Hermes Run failed"); }
}
export function hermesFailureDiagnostic(stage: HermesRunStage, error: unknown, nativeErrorObserved = false) {
  if (error instanceof HermesGatewayRequestError) return { stage, kind: "rpc" as const, method: error.method, code: error.code, nativeErrorObserved };
  if (error instanceof HermesNativeEventError) return { stage, kind: "native_event" as const, nativeErrorObserved: true };
  const known = ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "HermesGatewayProtocolError", "HermesGatewayReadyTimeout", "HermesRunFailure", "ChatAgentContextError"];
  const errorType = error instanceof Error && known.includes(error.name) ? error.name : "UnknownError";
  const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
  const protocolReason = typeof reason === "string" && ["event_invalid", "frame_too_large", "invalid_json", "unsupported_frame"].includes(reason) ? reason : undefined;
  return { stage, kind: "local" as const, errorType, ...(protocolReason ? { protocolReason } : {}), nativeErrorObserved };
}
