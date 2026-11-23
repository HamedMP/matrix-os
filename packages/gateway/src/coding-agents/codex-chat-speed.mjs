/** A new option ID distinguishes an explicit Chat choice from the old implicit tier. */
export const CODEX_CHAT_SPEED_OPTION = "codex_speed";
export const CODEX_CHAT_STANDARD_SPEED = "standard";

/** Native Codex retains a previous tier on omission. Null resets it to Standard. */
export function codexNativeServiceTier(chatSpeed, serviceTier) {
  return chatSpeed === CODEX_CHAT_STANDARD_SPEED ? null : chatSpeed ?? serviceTier;
}
