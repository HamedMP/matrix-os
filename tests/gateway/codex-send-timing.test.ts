import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexSendTiming } from "../../packages/gateway/src/coding-agents/codex-send-timing.mjs";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";

async function runnerStderr(): Promise<{ lines: string[]; dir: string }> {
  const runner = await startCodexStartupRunner({ failures: 0 });
  let stderr = "";
  runner.child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await waitForStartupText(runner.eventPath, "turn.completed");
    await runner.closed;
    return { lines: stderr.split("\n").filter((line) => line.includes("codex_send_timing")), dir: runner.dir };
  } finally {
    await runner.close();
  }
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("Codex runner send timings", () => {
  it("is a no-op when the runtime flag is absent", () => {
    const lines: string[] = [];
    const timing = createCodexSendTiming("session", (line: string) => lines.push(line), false);
    timing.runnerBoot();
    timing.beginTurn(1);
    timing.mark("process_ready", timing.now());
    timing.firstProviderDelta();
    timing.firstPersistedText();
    expect(lines).toEqual([]);
  });

  it("records runner boot, then one first delta and first persisted text per turn", () => {
    const lines: string[] = [];
    const timing = createCodexSendTiming("private-session-path", (line: string) => lines.push(line), true);
    timing.runnerBoot();
    timing.firstProviderDelta();
    timing.beginTurn(1);
    timing.firstProviderDelta();
    timing.firstProviderDelta();
    timing.firstPersistedText();
    timing.firstPersistedText();
    timing.beginTurn(2);
    timing.firstProviderDelta();
    const events = lines.map((line) => JSON.parse(line) as { event: string; session: string; turnIndex: number; stage: string; durationMs: number });
    expect(events.map((event) => [event.turnIndex, event.stage])).toEqual([
      [0, "runner_boot"], [1, "first_provider_delta"], [1, "first_persisted_text"], [2, "first_provider_delta"],
    ]);
    expect(new Set(events.map((event) => event.session)).size).toBe(1);
    expect(events.every((event) => event.event === "codex_send_timing" && event.durationMs >= 0)).toBe(true);
    expect(lines.join(" ")).not.toContain("private-session-path");
  });

  it("emits nothing from the real runner when the flag is off", async () => {
    expect((await runnerStderr()).lines).toEqual([]);
  });

  it("attributes real runner startup and first text stages without content or paths", async () => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
    const { lines, dir } = await runnerStderr();
    const events = lines.map((line) => JSON.parse(line) as { stage: string; turnIndex: number; durationMs: number });
    expect(events.map((event) => event.stage)).toEqual([
      "runner_boot", "native_proof_setup", "browser_lease_wait", "process_ready", "thread_account_proof",
      "thread_start", "browser_release_wait", "turn_account_proof", "turn_start", "first_provider_delta",
      "first_persisted_text",
    ]);
    expect(events.slice(1).every((event) => event.turnIndex === 1)).toBe(true);
    const output = lines.join("\n");
    expect(output).not.toContain("Reply once");
    expect(output).not.toContain("Started exactly once");
    expect(output).not.toContain(dir);
    expect(output).not.toContain("startup_thread");
  });
});
