import { describe, expect, it } from "vitest";
import { createCodexSendTiming } from "../../packages/gateway/src/coding-agents/codex-send-timing.mjs";

describe("Codex runner send timings", () => {
  it("keeps diagnostics off when the runtime flag is absent", () => {
    const lines: string[] = [];
    const timing = createCodexSendTiming("session", (line: string) => lines.push(line), false);
    timing.beginTurn(1);
    timing.mark("process_ready", timing.now());
    timing.firstProviderDelta();
    timing.firstPersistedText();
    expect(lines).toEqual([]);
  });
  it("records one first delta and first persisted text per turn with safe correlation", () => {
    const lines: string[] = [];
    const timing = createCodexSendTiming("private-session-path", (line: string) => lines.push(line));
    timing.beginTurn(1);
    timing.firstProviderDelta();
    timing.firstProviderDelta();
    timing.firstPersistedText();
    timing.firstPersistedText();
    timing.beginTurn(2);
    timing.firstProviderDelta();
    expect(lines).toHaveLength(3);
    const events = lines.map((line) => JSON.parse(line) as { event: string; session: string; turnIndex: number; stage: string; durationMs: number });
    expect(events.map((event) => [event.turnIndex, event.stage])).toEqual([
      [1, "first_provider_delta"], [1, "first_persisted_text"], [2, "first_provider_delta"],
    ]);
    expect(events.every((event) => event.event === "codex_send_timing" && event.durationMs >= 0)).toBe(true);
    expect(lines.join(" ")).not.toContain("private-session-path");
  });
});
