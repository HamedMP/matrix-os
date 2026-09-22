import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixDB } from "../../packages/kernel/src/db.js";
import { createIpcServer } from "../../packages/kernel/src/ipc-server.js";

const sdk = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((config: unknown) => config),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

describe("IPC server dependency registration", () => {
  const db = {} as MatrixDB;

  afterEach(() => vi.clearAllMocks());

  it("omits owner audio transcription when its dependency is absent", async () => {
    await createIpcServer(db, "/home/matrix/home");

    const config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map((registered) => registered.name)).not.toContain("transcribe");
  });

  it("registers owner audio transcription when owner home and transcriber are resolved", async () => {
    const transcriber = {
      transcribe: vi.fn(async () => ({ text: "managed", durationMs: 1_000 })),
    };
    await createIpcServer(db, "/home/matrix/home", undefined, transcriber);

    const config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map((registered) => registered.name)).toContain("transcribe");
  });
});
