import type { CanonicalChatDetailResponse, CanonicalChatRun } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { consecutiveText } from "./chat-electron-preview";

export const MAC_TERMINAL_PROBE_PREFIX = "MATRIX_MAC_TERMINAL_V1 ";
export const MAC_TERMINAL_PROBE_MAX_AGE_MS = 5 * 60 * 1_000;

export const MAC_TERMINAL_SYSTEM_CHECKS = [
  "/usr/bin/uname -s",
  "/usr/bin/uname -m",
  "/usr/bin/sw_vers -productVersion",
] as const;

export const MacTerminalProbeActionSchema = z.enum(["uname", "system-checks"]);
export type MacTerminalProbeAction = z.infer<typeof MacTerminalProbeActionSchema>;

export const MacTerminalSystemCheckOutputSchema = z.strictObject({
  kernel: z.literal("Darwin"),
  architecture: z.enum(["arm64", "x86_64"]),
  macOSVersion: z.string().regex(/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/),
});
export const MacTerminalProbeOutputSchema = z.union([z.literal("Darwin"), MacTerminalSystemCheckOutputSchema]);
export type MacTerminalProbeOutput = z.infer<typeof MacTerminalProbeOutputSchema>;

const Marker = z.strictObject({ targetId: z.uuid(), action: MacTerminalProbeActionSchema });
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
    for (const text of consecutiveText(message.parts)) {
      if (text.length > 128 * 1024) return null;

      for (const line of text.split(/\r?\n/)) {
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
