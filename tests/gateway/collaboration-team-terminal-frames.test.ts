import { describe, expect, it, vi } from "vitest";
import { CollaborationTerminalDispatcherError } from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import {
  TeamInputBudget,
  handleTeamTerminalFrame,
} from "../../packages/gateway/src/collaboration/team-terminal-frames.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const incarnation = "terminal-0123456789abcdef0123456789abcdef";
const action = (data = "ls\r") => ({
  type: "input_shared" as const,
  clientRequestId: "20000000-0000-4000-8000-000000000001",
  incarnation,
  connectionId: "connection_a",
  data,
});

describe("TeamInputBudget (spec 2710 caps)", () => {
  it("admits normal typing, refuses a burst over the byte budget and closes a sustained flood", () => {
    let nowMs = 0;
    const budget = new TeamInputBudget({ now: () => nowMs, bytesPerSecond: 10, framesPerSecond: 100, closeAfterSeconds: 3 });
    expect(budget.take(5)).toBe("ok");
    expect(budget.take(5)).toBe("ok");
    expect(budget.take(1)).toBe("limited");
    nowMs = 1_000;
    expect(budget.take(10)).toBe("ok");
    expect(budget.take(1)).toBe("limited");
    nowMs = 2_000;
    budget.take(10);
    // The third consecutive second over budget closes the connection.
    expect(budget.take(1)).toBe("close");
  });

  it("forgives a limited second once input calms down", () => {
    let nowMs = 0;
    const budget = new TeamInputBudget({ now: () => nowMs, bytesPerSecond: 4, framesPerSecond: 100, closeAfterSeconds: 2 });
    budget.take(4);
    expect(budget.take(1)).toBe("limited");
    nowMs = 5_000;
    expect(budget.take(1)).toBe("ok");
    nowMs = 6_000;
    budget.take(4);
    expect(budget.take(1)).toBe("limited");
  });

  it("caps frames per second independently of bytes", () => {
    const budget = new TeamInputBudget({ now: () => 0, bytesPerSecond: 1_000, framesPerSecond: 2, closeAfterSeconds: 3 });
    expect(budget.take(1)).toBe("ok");
    expect(budget.take(1)).toBe("ok");
    expect(budget.take(1)).toBe("limited");
  });
});

describe("handleTeamTerminalFrame", () => {
  it("answers a refused team input with a rejection frame instead of closing", async () => {
    const send = vi.fn();
    const outcome = await handleTeamTerminalFrame({
      scopeId, action: action(), budget: new TeamInputBudget(), send,
      dispatch: async () => { throw new CollaborationTerminalDispatcherError("input_paused"); },
    });
    expect(outcome).toBe("handled");
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toEqual({
      version: 1, type: "terminal.input_rejected", scopeId, incarnation,
      clientRequestId: "20000000-0000-4000-8000-000000000001", code: "input_paused",
    });
  });

  it("maps a viewer refusal and a legacy controller to bounded codes", async () => {
    for (const [code, expected] of [["forbidden", "forbidden"], ["held", "input_paused"]] as const) {
      const send = vi.fn();
      await handleTeamTerminalFrame({
        scopeId, action: action(), budget: new TeamInputBudget(), send,
        dispatch: async () => { throw new CollaborationTerminalDispatcherError(code); },
      });
      expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({ code: expected });
    }
  });

  it("lets revocation and lost terminals close the socket", async () => {
    for (const code of ["not_found", "unavailable"] as const) {
      await expect(handleTeamTerminalFrame({
        scopeId, action: action(), budget: new TeamInputBudget(), send: vi.fn(),
        dispatch: async () => { throw new CollaborationTerminalDispatcherError(code); },
      })).rejects.toBeInstanceOf(CollaborationTerminalDispatcherError);
    }
  });

  it("rejects over-budget input without dispatching it and closes a flood", async () => {
    const dispatch = vi.fn(async () => ({ action: "accepted" as const, shared: true as const }));
    const budget = { take: vi.fn().mockReturnValueOnce("limited").mockReturnValueOnce("close") } as unknown as TeamInputBudget;
    const send = vi.fn();
    await expect(handleTeamTerminalFrame({ scopeId, action: action(), budget, send, dispatch })).resolves.toBe("handled");
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({ code: "rate_limited" });
    await expect(handleTeamTerminalFrame({ scopeId, action: action(), budget, send, dispatch })).resolves.toBe("close");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches accepted input and reports it handled without a state broadcast", async () => {
    const dispatch = vi.fn(async () => ({ action: "accepted" as const, shared: true as const }));
    const send = vi.fn();
    await expect(handleTeamTerminalFrame({ scopeId, action: action("pwd\r"), budget: new TeamInputBudget(), send, dispatch })).resolves.toBe("handled");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
