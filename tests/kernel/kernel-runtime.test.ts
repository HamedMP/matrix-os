import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  kernelOptions: vi.fn(async () => ({})),
  query: vi.fn(),
}));

vi.mock("../../packages/kernel/src/options.js", () => ({
  kernelOptions: mocks.kernelOptions,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.query,
}));

import { spawnKernel, type KernelEvent } from "../../packages/kernel/src/kernel.js";

async function collectKernelEvents(): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of spawnKernel("hello", {
    db: {} as never,
    homePath: "/tmp/matrix-kernel-test",
  })) {
    events.push(event);
  }
  return events;
}

describe("spawnKernel runtime results", () => {
  beforeEach(() => {
    mocks.kernelOptions.mockClear();
    mocks.query.mockReset();
  });

  it("rejects a non-success SDK result instead of emitting successful completion", async () => {
    mocks.query.mockReturnValue((async function* () {
      yield { type: "system", subtype: "init", session_id: "session-1" };
      yield {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-1",
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        errors: ["provider detail must stay server-side"],
      };
    })());

    const events: KernelEvent[] = [];
    await expect((async () => {
      for await (const event of spawnKernel("hello", {
        db: {} as never,
        homePath: "/tmp/matrix-kernel-test",
      })) {
        events.push(event);
      }
    })()).rejects.toThrow("Kernel query failed");
    expect(events).toEqual([{ type: "init", sessionId: "session-1" }]);
  });

  it("continues to emit a successful SDK result", async () => {
    mocks.query.mockReturnValue((async function* () {
      yield { type: "system", subtype: "init", session_id: "session-2" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "session-2",
        result: "done",
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    })());

    await expect(collectKernelEvents()).resolves.toEqual([
      { type: "init", sessionId: "session-2" },
      {
        type: "result",
        data: {
          sessionId: "session-2",
          result: "done",
          cost: 0,
          turns: 1,
          tokensIn: 3,
          tokensOut: 2,
        },
      },
    ]);
  });
});
