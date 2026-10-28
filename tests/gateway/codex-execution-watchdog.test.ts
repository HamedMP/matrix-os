import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodexExecutionWatchdog } from "../../packages/gateway/src/coding-agents/codex-execution-watchdog.mjs";

let now = 0;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function elapsed(ms: number) {
  now += ms;
  await vi.advanceTimersByTimeAsync(1_000);
}

it.each([31 * 60_000, 25 * 60 * 60_000])("keeps a silent busy native turn alive for %i ms without progress keepalives", async duration => {
  const expire = vi.fn();
  const watchdog = createCodexExecutionWatchdog({ expire, waitingForHuman: () => false, env: {} });
  try {
    watchdog.start();
    await elapsed(duration);
    expect(expire).not.toHaveBeenCalled();
  } finally { watchdog.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores retired whole-turn timeout overrides rather than applying them to busy work", async () => {
  const expire = vi.fn();
  const watchdog = createCodexExecutionWatchdog({ expire, waitingForHuman: () => false,
    env: { MATRIX_CODEX_TURN_DEADLINE_MS: "1", MATRIX_CODEX_NO_PROGRESS_MS: "100" } });
  try { watchdog.start(); await elapsed(1_000); expect(expire).not.toHaveBeenCalled(); }
  finally { watchdog.stop(); }
});

it("still expires an individual tool that never returns", async () => {
  const expire = vi.fn();
  const watchdog = createCodexExecutionWatchdog({ expire, waitingForHuman: () => false, env: {} });
  watchdog.start();
  watchdog.toolStarted("tool_stuck", "mcpToolCall");
  await elapsed(10 * 60_000);
  expect(expire).toHaveBeenCalledExactlyOnceWith({ phase: "tool_deadline", toolCallId: "tool_stuck", durationMs: 10 * 60_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not count human wait against an individual tool deadline", async () => {
  const expire = vi.fn();
  let waiting = true;
  const watchdog = createCodexExecutionWatchdog({ expire, waitingForHuman: () => waiting, env: {} });
  try {
    watchdog.start(); watchdog.toolStarted("tool_waiting", "mcpToolCall");
    await elapsed(31 * 60_000);
    expect(expire).not.toHaveBeenCalled();
    waiting = false;
    await elapsed(9 * 60_000);
    expect(expire).not.toHaveBeenCalled();
    watchdog.toolCompleted("tool_waiting");
    await elapsed(25 * 60 * 60_000);
    expect(expire).not.toHaveBeenCalled();
  } finally { watchdog.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("clears tool ownership when Stop or turn completion ends monitoring", async () => {
  const expire = vi.fn();
  const watchdog = createCodexExecutionWatchdog({ expire, waitingForHuman: () => false, env: {} });
  watchdog.start(); watchdog.toolStarted("tool_stopped", "mcpToolCall"); watchdog.stop();
  await elapsed(25 * 60 * 60_000);
  expect(expire).not.toHaveBeenCalled();
  watchdog.start(); await elapsed(31 * 60_000);
  expect(expire).not.toHaveBeenCalled();
  watchdog.stop();
  expect(vi.getTimerCount()).toBe(0);
});
