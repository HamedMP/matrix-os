import { describe, expect, it, vi } from "vitest";
import { createNamedTerminalRouteController } from "../../packages/gateway/src/server.js";

function createQueue() {
  const pending: string[] = [];
  return {
    enqueue(raw: string): boolean {
      pending.push(raw);
      return true;
    },
    drain(callback: (raw: string) => void): void {
      while (pending.length > 0) {
        const raw = pending.shift();
        if (raw !== undefined) callback(raw);
      }
    },
    clear(): void {
      pending.length = 0;
    },
  };
}

function createSession() {
  return {
    onMessage: vi.fn(async (_raw: string) => undefined),
    onClose: vi.fn(),
  };
}

const destroyFrame = JSON.stringify({ type: "destroy" });
const inputFrame = JSON.stringify({ type: "input", data: "pwd\r" });

describe("named zellij terminal route close race", () => {
  it("preserves /ws/terminal/session destroy intent when the socket closes before attach resolves", async () => {
    const controller = createNamedTerminalRouteController({
      pendingInput: createQueue(),
      onBufferOverflow: vi.fn(),
    });
    const session = createSession();

    expect(controller.onMessage(destroyFrame)).toBe(true);
    controller.onClose();
    controller.onOpenResolved(session, { drainPendingInput: true });
    await Promise.resolve();

    expect(session.onMessage).toHaveBeenCalledWith(destroyFrame);
    expect(session.onClose).not.toHaveBeenCalled();
  });

  it("keeps /ws/terminal/session pre-open close without destroy as a detach-only cleanup", async () => {
    const controller = createNamedTerminalRouteController({
      pendingInput: createQueue(),
      onBufferOverflow: vi.fn(),
    });
    const session = createSession();

    expect(controller.onMessage(inputFrame)).toBe(true);
    controller.onClose();
    controller.onOpenResolved(session, { drainPendingInput: true });
    await Promise.resolve();

    expect(session.onMessage).not.toHaveBeenCalled();
    expect(session.onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves /ws/terminal?session destroy intent when the socket closes before attach resolves", async () => {
    const controller = createNamedTerminalRouteController();
    const session = createSession();

    expect(controller.onMessage(destroyFrame)).toBe(true);
    controller.onClose();
    controller.onOpenResolved(session, { drainPendingInput: false });
    await Promise.resolve();

    expect(session.onMessage).toHaveBeenCalledWith(destroyFrame);
    expect(session.onClose).not.toHaveBeenCalled();
  });

  it("keeps /ws/terminal?session pre-open close without destroy as a detach-only cleanup", async () => {
    const controller = createNamedTerminalRouteController();
    const session = createSession();

    expect(controller.onMessage(inputFrame)).toBe(false);
    controller.onClose();
    controller.onOpenResolved(session, { drainPendingInput: false });
    await Promise.resolve();

    expect(session.onMessage).not.toHaveBeenCalled();
    expect(session.onClose).toHaveBeenCalledTimes(1);
  });
});
