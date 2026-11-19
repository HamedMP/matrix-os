import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import { ChatNotFoundError } from "./errors.js";
import { mapRepositoryError } from "./orchestration-errors.js";
/** Server-only provenance; public JSON bodies and request headers cannot carry a symbol. */
export const SLACK_SUMMARY_DISPATCH = Symbol("slack-summary-dispatch");
export function assertSlackSummaryAdmission(principal: RequestPrincipal, owner: ChatOwner, chatId: string, requestId: string, proof?: true) {
  if (!requestId.startsWith("req_slack_summary_"))
    return;
  if (!proof || owner.type !== "personal" || owner.ownerId !== principal.userId || !/^req_slack_summary_[a-f0-9]{40}$/.test(requestId))
    mapRepositoryError(new ChatNotFoundError(chatId));
}
