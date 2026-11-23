import type { CanonicalChatSummary } from "@matrix-os/contracts";

export * from "./routine-origin-client.js";
export * from "./routine-origin-browser.js";
export * from "./routine-receipt.js";
export * from "./scheduled-message.js";
export * from "./use-routine-origin.js";
export { routineApprovalPlacement, routineOriginHistoryStatus } from "./routine-approval-placement.js";
export { routineOriginExecutor } from "../chat-agents/bots/routine-presentation.js";
export {createOwnerBrowserJsonRequest} from "../routine-action/owner-browser-request.js";

export type RoutineOriginChat = Pick<CanonicalChatSummary, "id" | "ownerScope" | "lifecycle" | "collaboration">;

/** Presentation eligibility only. The server independently authorizes origin reads and decisions. */
export function routineOriginChatEligible({ chat, ordinary, fresh }: {
  chat?: RoutineOriginChat;
  ordinary: boolean;
  fresh: boolean;
}): boolean {
  return fresh && ordinary && chat?.ownerScope.type === "personal" && chat.lifecycle === "active" && !chat.collaboration;
}
