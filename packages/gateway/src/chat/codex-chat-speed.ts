import type { AgentModelOption } from "@matrix-os/contracts";

/** A new option ID distinguishes an explicit Chat choice from the old implicit tier. */
export const CODEX_CHAT_SPEED_OPTION = "codex_speed";
export const CODEX_CHAT_STANDARD_SPEED = "standard";
export const CODEX_SERVICE_TIER_OPTION = "service_tier";
export const CODEX_DEFAULT_SERVICE_TIER = "default";

export function codexChatRunnerModelOptions(options: readonly AgentModelOption[]): AgentModelOption[] {
  const speed = options.find(({ id }) => id === CODEX_CHAT_SPEED_OPTION)?.value;
  const tier = typeof speed === "string" && speed !== CODEX_CHAT_STANDARD_SPEED
    ? speed
    : CODEX_DEFAULT_SERVICE_TIER;
  // The previous runner can remain live after a host update. Its service_tier
  // wire option must carry an explicit default to clear an inherited Fast tier.
  return [
    ...options.filter(({ id }) => id !== CODEX_SERVICE_TIER_OPTION && id !== CODEX_CHAT_SPEED_OPTION),
    { id: CODEX_SERVICE_TIER_OPTION, value: tier },
  ];
}
