import { isRoutineDirectChatId } from "../bots/routine-direct-chat-identity.js";
import type { RequestPrincipal } from "../request-principal.js";
import { ChatNotFoundError } from "./errors.js";
import { mapRepositoryError } from "./orchestration-errors.js";
import type { ChatOwner } from "./records.js";

/** In-process provenance, unavailable to parsed public turn bodies and proof headers. */
export const ROUTINE_DIRECT_DISPATCH = Symbol("routine-direct-dispatch");
export type RoutineDirectDispatch = "proposal" | "occurrence" | "approval";
const requestIds: Record<RoutineDirectDispatch, RegExp> = {
  proposal: /^req_cli_routine_[a-f0-9]{32}$/,
  occurrence: /^req_routine_fire_[a-f0-9]{24}(?:_a[23])?$/,
  approval: /^req_answer_in_[A-Za-z0-9_-]{8,64}$/,
};

/** The Bot adapter separately verifies the durable claim before any task or inference. */
export function assertRoutineDirectAdmission(
  principal: RequestPrincipal, owner: ChatOwner, chatId: string,
  requestId: string, dispatch?: RoutineDirectDispatch,
): void {
  if (!isRoutineDirectChatId(chatId)) return;
  if (!dispatch || owner.type !== "personal" || owner.ownerId !== principal.userId || !requestIds[dispatch].test(requestId)) {
    mapRepositoryError(new ChatNotFoundError(chatId));
  }
}
