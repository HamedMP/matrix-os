import type { CanonicalChatDetailResponse, CanonicalChatMessage, CanonicalChatRun } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const CHAT_ELECTRON_PREVIEW_PREFIX = "MATRIX_ELECTRON_PREVIEW_V1 ";
export const CHAT_ELECTRON_PREVIEW_MAX_AGE_MS = 10 * 60 * 1_000;
export const CHAT_ELECTRON_PREVIEW_SOURCE = "desktop/src/renderer/src/features/signin/SignIn.tsx";
export const CHAT_ELECTRON_PREVIEW_BASE_LABEL = "YOUR SPACE TO BEGIN";

export const ChatElectronPreviewMarkerSchema = z.strictObject({
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().regex(/^[A-Z0-9][A-Z0-9 .!?-]{2,54}$/).refine(label => label !== CHAT_ELECTRON_PREVIEW_BASE_LABEL),
  mainChecksPassed: z.literal(true),
  operation: z.literal("verify-sign-in-recovery").optional(),
  backgroundTargetId: z.uuid().optional(),
}).refine(marker => !marker.backgroundTargetId || marker.operation === "verify-sign-in-recovery");

export type ChatElectronPreviewMarker = z.infer<typeof ChatElectronPreviewMarkerSchema>;

function markerLines(text: string): string[] {
  if (text.length > 128 * 1024) return [];
  let fence: string | undefined;
  const matches: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter && !fence) {
      fence = delimiter[1];
    } else if (delimiter && fence && delimiter[1]?.startsWith(fence) && !delimiter[2]?.trim()) {
      fence = undefined;
    } else if (!fence && line.startsWith(CHAT_ELECTRON_PREVIEW_PREFIX)) {
      matches.push(line);
      if (matches.length > 1) break;
    }
  }
  return matches;
}

export function parseChatElectronPreviewMarker(text: string): ChatElectronPreviewMarker | null {
  const lines = markerLines(text);
  if (lines.length !== 1 || lines[0]!.length > 512) return null;
  try {
    const parsed = ChatElectronPreviewMarkerSchema.safeParse(JSON.parse(lines[0]!.slice(CHAT_ELECTRON_PREVIEW_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

export function isCurrentChatElectronPreviewRun(run: CanonicalChatRun, now = Date.now()): boolean {
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : NaN;
  const age = now - completedAt;
  return run.status === "completed" && run.executionRoot?.kind === "worktree"
    && age >= 0 && age < CHAT_ELECTRON_PREVIEW_MAX_AGE_MS;
}

export function* consecutiveText(parts: CanonicalChatMessage["parts"]) {
  let text = "";
  for (const part of parts) {
    if (part.type === "text") {
      // Recovered output can split a line at a storage boundary.
      text += part.text;
    } else if (text) {
      yield text;
      text = "";
    }
  }
  if (text) yield text;
}

export function getChatElectronPreviewMarkerForRun(
  detail: CanonicalChatDetailResponse,
  runId: string,
): ChatElectronPreviewMarker | null {
  const chatId = detail.record.chat.id;
  const run = detail.runs.find(candidate => candidate.id === runId && candidate.chatId === chatId);
  if (!run) return null;

  const candidates = [];
  for (const message of detail.messages) {
    if (message.role !== "assistant" || message.state !== "committed" || message.chatId !== chatId
      || message.runId !== runId || (message.turnId !== undefined && message.turnId !== run.turnId)) continue;
    for (const text of consecutiveText(message.parts)) {
      const lines = markerLines(text);
      if (lines.length + candidates.length > 1) return null;
      candidates.push(...lines);
    }
  }
  return candidates[0] ? parseChatElectronPreviewMarker(candidates[0]) : null;
}
