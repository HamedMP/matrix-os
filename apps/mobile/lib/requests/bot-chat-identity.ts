import { BotDirectChatResponseSchema, CanonicalChatIdSchema } from "@matrix-os/contracts";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

/** Retained binding read does not require an active Bot definition or create a Chat. */
export async function fetchSavedBotChatIdentity(token: string, gatewayUrl: string, chatId: string) {
  const id = CanonicalChatIdSchema.parse(chatId);
  const result = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(id)}/bot`), token,
    schema: BotDirectChatResponseSchema, errorMessage: "This task’s Chat could not be opened.",
  });
  return result.agentId;
}
