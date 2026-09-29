import type { CanonicalChatModelSelection } from "#canonical-chat";

/** Used only by verified direct bot Chats; never offered in the provider picker. */
export const MATRIX_BOT_INSTANCE_ID = "matrix_bot_default";
export const MATRIX_BOT_MODEL = "auto";
export const MATRIX_BOT_SELECTION: CanonicalChatModelSelection = Object.freeze({
  instanceId: MATRIX_BOT_INSTANCE_ID,
  model: MATRIX_BOT_MODEL,
});
