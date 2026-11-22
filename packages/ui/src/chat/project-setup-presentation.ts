import { canonicalAssistantOutputMessages, type CanonicalChatDetailResponse, type ProjectSetupDraft } from "@matrix-os/contracts";

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
    ? ([...messages].reverse().find(
        (message) => message.role === "assistant" && !message.tool && message.runId === runId,
      )?.id ?? null)
    : null;
}

export function projectSetupDetailPresentation(
  detail: CanonicalChatDetailResponse,
  draft: ProjectSetupDraft | null,
): CanonicalChatDetailResponse {
  const runs = detail.runs.filter(run => run.context?.projectSetupDraft);
  const current = draft?.chatId === detail.record?.chat.id ? draft : null;
  const runIds = [...runs.map(run => run.id), ...(current?.generation?.runId ? [current.generation.runId] : [])];
  if (runIds.length === 0) return detail;
  const combined = canonicalAssistantOutputMessages(detail.messages);
  const resultIds = runIds.flatMap(runId => {
    const result = [...combined].reverse().find(message => message.role === "assistant" && message.runId === runId);
    return result ? [result.id] : [];
  });
  const messages = combined.map(message => {
    if (!resultIds.includes(message.id)) return message;
    const run = runs.find(candidate => candidate.id === message.runId);
    const text = projectSetupGenerationText(current, message.runId)
      ?? (run?.status === "completed" ? "I drafted your project files for review."
        : run?.status === "failed" || run?.status === "aborted" ? "I couldn’t finish the draft. Your answers are kept."
          : "I’m drafting your project files for review.");
    return { ...message, parts: [{ type: "text" as const, text }] };
  });
  return { ...detail, messages };
}
