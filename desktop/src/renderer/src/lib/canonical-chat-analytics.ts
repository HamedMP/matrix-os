import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { DesktopAnalyticsDetail } from "./desktop-analytics";

export type ChatHarness = Extract<
  DesktopAnalyticsDetail,
  { name: "desktop_chat_message_send_succeeded" }
>["harness"];

export interface CanonicalChatResponseAnalytics {
  chatScope: "global" | "project";
  harness: ChatHarness;
  model: string;
  responseCharacterCount: number;
}

export function desktopChatModelProvider(model: string, harness: ChatHarness): string {
  const separator = model.indexOf(":");
  if (separator > 0) return model.slice(0, separator).toLocaleLowerCase();
  if (harness === "codex") return "openai";
  if (harness === "claude_code" || harness === "kernel") return "anthropic";
  return "unknown";
}

export function completedResponseAnalytics(
  detail: CanonicalChatDetailResponse,
  runId: string,
): CanonicalChatResponseAnalytics | undefined {
  const run = detail.runs.find((candidate) => candidate.id === runId);
  if (!run) return undefined;
  const responseCharacterCount = detail.messages
    .filter((message) => message.role === "assistant" && message.runId === runId)
    .flatMap((message) => message.parts)
    .reduce((total, part) => (
      part.type === "text" ? total + [...part.text].length : total
    ), 0);
  return {
    chatScope: detail.record.projectId === undefined ? "global" : "project",
    harness: run.driverKind,
    model: run.selection.model,
    responseCharacterCount,
  };
}
