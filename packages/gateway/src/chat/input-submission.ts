import {
  CanonicalSubmitChatInputRequestSchema,
  type CanonicalSubmitChatInputRequest,
  type CanonicalChatInputSubmissionResponse,
} from "@matrix-os/contracts";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";

export async function submitCanonicalInput(options: {
  repository: Pick<ChatRepository, "getPendingInput" | "getAdapterState">;
  active?: { chatId: string; owner: ChatOwner; adapter: CanonicalChatProviderAdapter; instanceId: string };
  unavailable(): Error;
}, owner: ChatOwner, chatId: string, runId: string, requestId: string,
inputValue: CanonicalSubmitChatInputRequest): Promise<CanonicalChatInputSubmissionResponse> {
  const input = CanonicalSubmitChatInputRequestSchema.parse(inputValue);
  const active = options.active;
  if (!active || active.chatId !== chatId || active.owner.type !== owner.type
    || active.owner.ownerId !== owner.ownerId || !active.adapter.submitInput) throw options.unavailable();
  const pending = await options.repository.getPendingInput(owner, { chatId, runId, requestId });
  if (!pending?.input) throw options.unavailable();
  const state = await options.repository.getAdapterState(owner, {
    runId, driverKind: active.adapter.driverKind, instanceId: active.instanceId,
  });
  await active.adapter.submitInput({ owner, chatId, runId, requestId, answers: input.answers,
    clientRequestId: input.clientRequestId,
    ...(state ? { state: active.adapter.parseState(state.state) } : {}),
  });
  return { requestId, submission: "accepted" };
}
