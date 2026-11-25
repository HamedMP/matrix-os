import { describe, expect, it, vi } from "vitest";
import { createChatMacTerminalService } from "@desktop/main/chat-mac-terminal/service";

const context = { chatId: "chat_origin", projectId: "proj_test", worktreeId: "wt_test", scopeKey: "owner-scope" };

function setup() {
  const terminal = { id: "t7", run: vi.fn().mockResolvedValue("Darwin"), dispose: vi.fn().mockResolvedValue(undefined) };
  const deps = {
    enabled: true,
    readTerminalContext: vi.fn().mockResolvedValue(context),
    isTerminalContextCurrent: vi.fn(() => true),
    readTerminalRequest: vi.fn(),
    isTerminalRequestCurrent: vi.fn(() => true),
    returnTerminalResult: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(true),
    prepareTerminal: vi.fn().mockResolvedValue(terminal),
  };
  const service = createChatMacTerminalService(deps);
  async function prepare() {
    const prepared = await service.prepare({ chatId: context.chatId, worktreeId: context.worktreeId });
    if (prepared.status !== "ready") throw new Error("expected a ready terminal");
    deps.readTerminalRequest.mockResolvedValue({ ...context, runId: "run_probe",
      targetId: prepared.targetId, action: "uname", expiresAt: prepared.expiresAt });
    return prepared;
  }
  return { service, deps, terminal, prepare };
}

describe("approved Matrix Chat Mac terminal grant", () => {
  it("prepares one dedicated terminal and dispatches and returns without a second approval", async () => {
    const { deps, service, terminal, prepare } = setup();
    const grant = await prepare();
    expect(grant.terminalId).toBe("t7");
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "returned" });
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(terminal.run).toHaveBeenCalledTimes(1);
    expect(deps.returnTerminalResult).toHaveBeenCalledWith(expect.objectContaining({ targetId: grant.targetId }),
      { terminalId: "t7", output: "Darwin" }, terminal.run.mock.calls[0]![0]);
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "already-handled" });
    await service.cancelAll();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("never creates a terminal if the native approval is declined", async () => {
    const { deps, service } = setup();
    deps.approve.mockResolvedValue(false);
    expect(await service.prepare({ chatId: context.chatId, worktreeId: context.worktreeId })).toEqual({ status: "declined" });
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
  });

  it("rejects a different target, owner scope or worktree before the terminal receives input", async () => {
    const { deps, service, terminal, prepare } = setup();
    const grant = await prepare();
    const request = { ...context, runId: "run_probe", targetId: grant.targetId,
      action: "uname", expiresAt: grant.expiresAt };
    for (const change of [{ targetId: "other" }, { scopeKey: "another" }, { worktreeId: "wt_another" },
      { action: "unexpected" }, { expiresAt: Date.now() - 10 }]) {
      deps.readTerminalRequest.mockResolvedValue({ ...request, ...change });
      expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    }
    expect(terminal.run).not.toHaveBeenCalled();
    await service.cancelAll();
  });

  it("revokes a reservation on authority loss and never returns output from the canceled run", async () => {
    const { deps, service, terminal, prepare } = setup();
    await prepare();
    deps.isTerminalContextCurrent.mockReturnValue(false);
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    expect(terminal.run).not.toHaveBeenCalled();
    await service.cancelAll();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
  });

  it("does not dispatch again when return delivery fails", async () => {
    const { deps, service, terminal, prepare } = setup();
    await prepare();
    deps.returnTerminalResult.mockRejectedValueOnce(new Error("connection failed"));
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "failed" });
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "already-handled" });
    expect(terminal.run).toHaveBeenCalledTimes(1);
    await service.cancelAll();
  });
});
