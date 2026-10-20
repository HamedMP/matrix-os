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
  /** The newest page of the chat, or the older page `cursor` names. */
  detail(chatId: string, cursor?: string): Promise<CanonicalChatDetailResponse>;
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

export interface OnboardingAdmissionRequestIds {
  create: string;
  turn: string;
}

export function onboardingAdmissionRequestIds(): OnboardingAdmissionRequestIds {
  return { create: onboardingRequestId(), turn: onboardingRequestId() };
}

/**
 * Sends the turn into `chatId`, or into a new chat named `title` when there is none yet or it was deleted.
 * Retrying with the same `requestIds` replays an admission whose response was lost instead of starting it again.
 */
export async function admitOnboardingTurn({ port, chatId, title, prompt, selection, requestIds }: {
  port: Pick<OnboardingChatPort, "create" | "detail" | "admitTurn" | "isNotFound">;
  chatId: string | null;
  title: string;
  prompt: string;
  selection: CanonicalComposerSelection;
  requestIds: OnboardingAdmissionRequestIds;
}): Promise<{ chatId: string; runId: string }> {
  const modelSelection = {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options.length > 0 ? { options: selection.options } : {}),
  };
  let targetId = chatId;
  let baseRevision = 0;
  let route = { selection: modelSelection, interactionMode: selection.interactionMode, permissionMode: selection.permissionMode };
  if (targetId) {
    try {
      const detail = await port.detail(targetId);
      baseRevision = detail.record.chat.revision;
      // A chat stays on the AI it first ran on. Follow-ups and retries reuse its last run's
      // selection and modes, so a later change in the widget's AI never raises their permissions.
      const binding = detail.record.providerBinding;
      if (binding) {
        const last = latestRun(detail.runs, binding.instanceId);
        if (last) route = { selection: last.selection, interactionMode: last.interactionMode, permissionMode: last.permissionMode };
        else targetId = null; // Bound but never ran: nothing to copy, so start a new chat rather than guess.
      }
    } catch (error: unknown) {
      if (!port.isNotFound(error)) throw error;
      targetId = null;
    }
  }
  if (!targetId) {
    const created = await port.create({ clientRequestId: requestIds.create, title, currentSelection: modelSelection });
    targetId = created.chat.id;
    baseRevision = created.chat.revision;
  }
  const admitted = await port.admitTurn(targetId, {
    clientRequestId: requestIds.turn,
    baseRevision,
    parts: [{ type: "text", text: prompt }],
    ...route,
  });
  return { chatId: admitted.record.chat.id, runId: admitted.run.id };
}

function latestRun(runs: CanonicalChatDetailResponse["runs"], instanceId: string): CanonicalChatDetailResponse["runs"][number] | null {
  let latest: CanonicalChatDetailResponse["runs"][number] | null = null;
  for (const run of runs) {
    if (run.instanceId === instanceId && (!latest || run.createdAt > latest.createdAt)) latest = run;
  }
  return latest;
}
