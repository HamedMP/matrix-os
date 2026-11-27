import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { REMOTE_MCP_CATALOG, remoteMcpCatalogEntryForUrl } from "@matrix-os/contracts/remote-mcp-catalog";
import type { ProjectSetupTransport } from "./use-project-setup.js";

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

/** Use displayed messages in transcript order so the anchor exists after continuations are combined. */
export function projectSetupControlsMessageId(
  draft: ProjectSetupDraft | null,
  messages: Parameters<typeof projectSetupGenerationResultId>[1],
): string | undefined {
  const questionId = draft?.currentQuestionMessageId;
  if (!questionId || draft?.interview || draft?.step !== "review" || !draft.generation?.runId) return questionId;
  const questionIndex = messages.findIndex((message) => message.id === questionId);
  // The draft response can reach the client before the matching transcript event.
  if (questionIndex < 0) return questionId;
  return projectSetupGenerationResultId(draft, messages.slice(questionIndex + 1)) ?? questionId;
}

export function projectSetupDetailPresentation(
  detail: CanonicalChatDetailResponse,
  draft: ProjectSetupDraft | null,
): CanonicalChatDetailResponse {
  if (!draft?.generation?.runId && !detail.runs.some(run => run.context?.projectSetupDraft)) return detail;
  const chatId = detail.record.chat.id;
  const runs = detail.runs.filter(run => run.chatId === chatId && run.context?.projectSetupDraft);
  const current = draft?.chatId === chatId ? draft : null;
  const interviewRuns = runs.filter(run => run.context?.projectSetupDraft?.mode === "interview");
  const interviewRunIds = new Set(interviewRuns.map(run => run.id));
  if (current?.interview && current.generation?.runId) interviewRunIds.add(current.generation.runId);
  const interviewTurnIds = new Set(interviewRuns.map(run => run.turnId));
  const legacyRunIds = runs.filter(run => !interviewRunIds.has(run.id)).map(run => run.id);
  if (current?.generation?.runId && !current.interview) legacyRunIds.push(current.generation.runId);
  if (legacyRunIds.length === 0 && interviewRunIds.size === 0) return detail;
  // The provider input has a turn ID but no run ID. Only suppress the canonical input
  // attached to an admitted setup run, so normal answers can contain any text.
  const setupTurnIds = new Set(runs.map(run => run.turnId));
  const setupInputIds = new Set(detail.turns
    .filter(turn => turn.chatId === chatId && setupTurnIds.has(turn.id))
    .map(turn => turn.inputMessageId));
  const combined = canonicalAssistantOutputMessages(detail.messages.filter(message => {
    if (message.chatId !== chatId) return true;
    if (message.runId && interviewRunIds.has(message.runId)) return false;
    return message.role !== "user" || !setupInputIds.has(message.id);
  }));
  const resultIds = legacyRunIds.flatMap(runId => {
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
  // Structured interview turns are internal. The accepted discussion and the
  // validated reply are independent canonical transcript entries.
  const activities = detail.activities.filter(activity => activity.chatId !== chatId
    || (!interviewRunIds.has(activity.runId)
      && (activity.type !== "assistant.delta" || !legacyRunIds.includes(activity.runId))));
  return {
    ...detail,
    messages,
    activities,
    runs: detail.runs.filter(run => run.chatId !== chatId || !interviewRunIds.has(run.id)),
    turns: detail.turns.filter(turn => turn.chatId !== chatId || !interviewTurnIds.has(turn.id)),
  };
}

export function useProjectSetupMcpConnection(
  transport: ProjectSetupTransport | null,
  service: string | undefined,
  settingsOpen: boolean,
) {
  const [connected, setConnected] = useState(false);
  const connectionRequest = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    setConnected(false);
    return () => {
      connectionRequest.current?.abort();
      connectionRequest.current = null;
    };
  }, [transport, service]);

  const checkConnection = useCallback(async () => {
    if (!transport || !service || connectionRequest.current)
      return;
    const controller = new AbortController();
    connectionRequest.current = controller;
    try {
      const payload = await transport.get("/api/mcp-servers", controller.signal);
      if (controller.signal.aborted) return;
      // Only the current Settings projection can confirm a ready connection.
      const name = service.toLowerCase();
      const catalogEntry = REMOTE_MCP_CATALOG.find(entry => entry.name.toLowerCase() === name);
      const matches = Array.isArray(payload)
        ? payload.filter((item: unknown) => {
            if (typeof item !== "object" || item === null) return false;
            const entry = item as Record<string, unknown>;
            return (
              typeof entry.id === "string" &&
              entry.status === "ready" &&
              entry.enabled === true &&
              (catalogEntry
                ? typeof entry.url === "string" && remoteMcpCatalogEntryForUrl(entry.url)?.id === catalogEntry.id
                : typeof entry.name === "string" && entry.name.toLowerCase() === name)
            );
          })
        : [];
      setConnected(matches.length === 1);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn(
          "[project-setup] Connection state unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        setConnected(false);
      }
    } finally {
      if (connectionRequest.current === controller) connectionRequest.current = null;
    }
  }, [transport, service]);
  useEffect(() => {
    const check = () => {
      void checkConnection();
    };
    if (settingsOpen) {
      setConnected(false);
      return;
    }
    if (!service) return;
    check();
    window.addEventListener("focus", check);
    return () => {
      window.removeEventListener("focus", check);
      connectionRequest.current?.abort();
      connectionRequest.current = null;
    };
  }, [checkConnection, service, settingsOpen]);

  return { connected, checkConnection };
}
