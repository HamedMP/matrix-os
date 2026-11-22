import type { CanonicalChatDetailResponse, ProjectSetupDraft } from "@matrix-os/contracts";

/** Present only this setup's structured generation result as a normal Chat reply. */
export function projectSetupGenerationText(
  draft: ProjectSetupDraft | null,
  runId: string | null | undefined,
): string | null {
  if (!draft?.generation?.runId || draft.generation.runId !== runId) return null;
  if (draft.generation.status === "completed") {
    return `I drafted your project guidance${draft.skill ? " and skill" : ""}. Review the Markdown below before saving.`;
  }
  if (draft.generation.status === "failed" || draft.generation.status === "unavailable")
    return "I couldn’t draft your project files. Your answers are kept. Choose a supported model and try again.";
  return "I’m drafting your project files for review.";
}

export function projectSetupGenerationResultId(
  draft: ProjectSetupDraft | null,
  messages: readonly { id: string; role: string; runId?: string | null; tool?: string }[],
): string | null {
  const runId = draft?.generation?.runId;
  return runId
    ? (messages.findLast(
        (message) => message.role === "assistant" && !message.tool && message.runId === runId,
      )?.id ?? null)
    : null;
}

export function projectSetupDetailPresentation(
  detail: CanonicalChatDetailResponse,
  draft: ProjectSetupDraft | null,
): CanonicalChatDetailResponse {
  if (draft?.chatId !== detail.record.chat.id || !draft.generation?.runId) return detail;
  const resultId = projectSetupGenerationResultId(draft, detail.messages);
  const messages = detail.messages.map((message) => {
    if (message.id !== resultId) return message;
    const text = projectSetupGenerationText(draft, message.runId);
    return text ? { ...message, parts: [{ type: "text" as const, text }] } : message;
  });
  return { ...detail, messages };
}
