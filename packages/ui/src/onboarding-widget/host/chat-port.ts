import type {
  CanonicalChatDetailResponse,
  CanonicalChatRecord,
  CanonicalChatTurnAdmissionResponse,
  CanonicalCreateChatRequest,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import type { CanonicalComposerSelection } from "../../canonical-composer-selection.js";

/** What the onboarding widget needs from a host's canonical Chat transport. */
export interface OnboardingChatPort {
  create(input: CanonicalCreateChatRequest): Promise<Pick<CanonicalChatRecord, "chat">>;
  detail(chatId: string): Promise<CanonicalChatDetailResponse>;
  admitTurn(chatId: string, input: CanonicalCreateChatTurnRequest): Promise<CanonicalChatTurnAdmissionResponse>;
  /** Calls `onChange` whenever the chat may have changed; returns a disposer. */
  watch(chatId: string, onChange: () => void): () => void;
  isNotFound(error: unknown): boolean;
  /** Network-level failures mean the computer is still waking; everything else is a real failure. */
  isComputerStarting(error: unknown): boolean;
}

export function onboardingRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Sends the turn into `chatId`, or into a new chat named `title` when there is none yet or it was deleted. */
export async function admitOnboardingTurn({ port, chatId, title, prompt, selection }: {
  port: Pick<OnboardingChatPort, "create" | "detail" | "admitTurn" | "isNotFound">;
  chatId: string | null;
  title: string;
  prompt: string;
  selection: CanonicalComposerSelection;
}): Promise<{ chatId: string; runId: string }> {
  const modelSelection = {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options.length > 0 ? { options: selection.options } : {}),
  };
  let targetId = chatId;
  let baseRevision = 0;
  if (targetId) {
    try {
      baseRevision = (await port.detail(targetId)).record.chat.revision;
    } catch (error: unknown) {
      if (!port.isNotFound(error)) throw error;
      targetId = null;
    }
  }
  if (!targetId) {
    const created = await port.create({ clientRequestId: onboardingRequestId(), title, currentSelection: modelSelection });
    targetId = created.chat.id;
    baseRevision = created.chat.revision;
  }
  const admitted = await port.admitTurn(targetId, {
    clientRequestId: onboardingRequestId(),
    baseRevision,
    parts: [{ type: "text", text: prompt }],
    selection: modelSelection,
    interactionMode: selection.interactionMode,
    permissionMode: selection.permissionMode,
  });
  return { chatId: admitted.record.chat.id, runId: admitted.run.id };
}
