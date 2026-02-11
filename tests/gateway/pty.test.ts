import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPtyHandler,
  type PtyMessage,
  type PtyServerMessage,
  type SpawnFn,
} from "../../packages/gateway/src/pty.js";

function createMockPty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  };
}

function createMockSpawn(mockPty: ReturnType<typeof createMockPty>) {
  return vi.fn(() => mockPty) as unknown as SpawnFn;
}

describe("PTY handler", () => {
  let mockPty: ReturnType<typeof createMockPty>;
  let mockSpawn: ReturnType<typeof createMockSpawn>;

  beforeEach(() => {
    mockPty = createMockPty();
    mockSpawn = createMockSpawn(mockPty);
  });

  it("spawns a PTY process on init", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();

    expect(mockSpawn).toHaveBeenCalledOnce();
    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[1]).toEqual([]);
    expect(call[2]).toMatchObject({
      cwd: "/tmp/test-home",
    });
  });

  it("writes input data to PTY", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();

    handler.onMessage({ type: "input", data: "ls -la\r" });
    expect(mockPty.write).toHaveBeenCalledWith("ls -la\r");
  });

  it("resizes PTY on resize message", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();

    handler.onMessage({ type: "resize", cols: 120, rows: 40 });
    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });

  it("emits output events from PTY data", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    const received: PtyServerMessage[] = [];
    handler.onSend((msg) => received.push(msg));

    handler.open();

    const dataCallback = mockPty.onData.mock.calls[0][0];
    dataCallback("total 42\n");

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "output", data: "total 42\n" });
  });

  it("emits exit event when PTY exits", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    const received: PtyServerMessage[] = [];
    handler.onSend((msg) => received.push(msg));

    handler.open();

    const exitCallback = mockPty.onExit.mock.calls[0][0];
    exitCallback({ exitCode: 0, signal: 0 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "exit", code: 0 });
  });

  it("kills PTY on close", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();
    handler.close();

    expect(mockPty.kill).toHaveBeenCalledOnce();
  });

  it("ignores input before open", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.onMessage({ type: "input", data: "hello" });

    expect(mockPty.write).not.toHaveBeenCalled();
  });

  it("ignores unknown message types", () => {
    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();

    handler.onMessage({ type: "unknown" } as unknown as PtyMessage);
    expect(mockPty.write).not.toHaveBeenCalled();
    expect(mockPty.resize).not.toHaveBeenCalled();
  });

  it("uses default shell from env", () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";

    const handler = createPtyHandler("/tmp/test-home", mockSpawn);
    handler.open();

    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[0]).toBe("/bin/zsh");

    process.env.SHELL = originalShell;
  });
});
