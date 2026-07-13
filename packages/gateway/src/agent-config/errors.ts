export type AgentConfigErrorKind =
  | "agent_config_invalid"
  | "agent_config_conflict"
  | "runtime_unavailable"
  | "runtime_switch_failed"
  | "not_configured"
  | "invalid_response";

export class AgentConfigError extends Error {
  constructor(
    readonly kind: AgentConfigErrorKind,
    cause?: unknown,
  ) {
    super(kind);
    this.name = "AgentConfigError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAgentConfigError(error: unknown): error is AgentConfigError {
  return error instanceof AgentConfigError;
}
