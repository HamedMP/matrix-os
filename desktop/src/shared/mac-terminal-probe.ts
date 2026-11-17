import type { CanonicalChatDetailResponse, CanonicalChatRun } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const MAC_TERMINAL_PROBE_PREFIX = "MATRIX_MAC_TERMINAL_V1 ";
export const MAC_TERMINAL_PROBE_MAX_AGE_MS = 5 * 60 * 1_000;

const Marker = z.strictObject({ targetId: z.uuid(), action: z.literal("uname") });
export type MacTerminalProbeMarker = z.infer<typeof Marker>;

export function isCurrentMacTerminalProbeRun(run: CanonicalChatRun, now = Date.now()): boolean {
  const age = now - Date.parse(run.completedAt ?? "");
  return run.status === "completed" && age >= 0 && age < MAC_TERMINAL_PROBE_MAX_AGE_MS;
}

export function getLatestCompletedMacTerminalRun(detail: CanonicalChatDetailResponse): CanonicalChatRun | undefined {
  let latest: CanonicalChatRun | undefined;
  let latestCompletion = -Infinity;
  for (const run of detail.runs) {
    if (run.chatId !== detail.record.chat.id || run.status !== "completed") continue;
    const completion = Date.parse(run.completedAt ?? "");
    if (completion >= latestCompletion) {
      latest = run;
      latestCompletion = completion;
    }
  }
  return latest;
}

export function getMacTerminalProbeMarkerForRun(
  detail: CanonicalChatDetailResponse,
  runId: string,
): MacTerminalProbeMarker | null {
  const chatId = detail.record.chat.id;
  const run = detail.runs.find(candidate => candidate.id === runId && candidate.chatId === chatId
    && candidate.status === "completed");
  if (!run) return null;

  let marker: string | undefined;
  for (const message of detail.messages) {
    if (message.role !== "assistant" || message.state !== "committed" || message.chatId !== chatId
      || message.runId !== runId || message.turnId !== run.turnId) continue;
    let fence: string | undefined;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      if (part.text.length > 128 * 1024) return null;

      for (const line of part.text.split(/\r?\n/)) {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (delimiter && !fence) {
          fence = delimiter[1];
        } else if (delimiter && fence && delimiter[1]?.startsWith(fence) && !delimiter[2]?.trim()) {
          fence = undefined;
        } else if (!fence && line.startsWith(MAC_TERMINAL_PROBE_PREFIX)) {
          if (marker !== undefined || line.length > 512) return null;
          marker = line.slice(MAC_TERMINAL_PROBE_PREFIX.length);
        }
      }
    }
  }
  if (!marker) return null;
  try {
    const parsed = Marker.safeParse(JSON.parse(marker));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}
