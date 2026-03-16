import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createPtyHandler,
  type SpawnFn,
} from "../../packages/gateway/src/pty.js";

const TEST_HOME = join(import.meta.dirname ?? __dirname, ".tmp-pty-cwd-test");

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

describe("PTY handler cwd parameter", () => {
  let mockPty: ReturnType<typeof createMockPty>;
  let mockSpawn: ReturnType<typeof createMockSpawn>;

  beforeEach(() => {
    mockPty = createMockPty();
    mockSpawn = createMockSpawn(mockPty);
    mkdirSync(join(TEST_HOME, "projects", "app"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("uses homePath when no cwd provided", () => {
    const handler = createPtyHandler(TEST_HOME, mockSpawn);
    handler.open();

    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: TEST_HOME });
  });

  it("uses cwd when provided and directory exists", () => {
    const cwdPath = join(TEST_HOME, "projects", "app");
    const handler = createPtyHandler(TEST_HOME, mockSpawn, cwdPath);
    handler.open();

    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: cwdPath });
  });

  it("falls back to homePath when cwd does not exist", () => {
    const handler = createPtyHandler(TEST_HOME, mockSpawn, "/nonexistent/path");
    handler.open();

    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: TEST_HOME });
  });

  it("uses homePath when cwd is undefined", () => {
    const handler = createPtyHandler(TEST_HOME, mockSpawn, undefined);
    handler.open();

    const call = vi.mocked(mockSpawn).mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: TEST_HOME });
  });
});
