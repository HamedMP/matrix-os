import type { CanonicalChatModelSelection } from "@matrix-os/contracts";

/** The provider instance recipe bots run on; never offered in a model picker. */
export const MATRIX_BOT_INSTANCE_ID = "matrix_bot_default";
/** The route is resolved from Provider V3 when each run starts, not stored with the bot. */
export const MATRIX_BOT_MODEL = "auto";

export const MATRIX_BOT_SELECTION: CanonicalChatModelSelection = Object.freeze({
  instanceId: MATRIX_BOT_INSTANCE_ID,
  model: MATRIX_BOT_MODEL,
});
