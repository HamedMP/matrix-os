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

describe("IPC owner data import registration", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it("registers the same owner import actions when owner authentication exists", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "owner-test-token");
    await createIpcServer({} as MatrixDB);
    const config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["refresh_imported_data", "get_imported_data_status", "read_imported_data_pages", "preview_data_url", "delete_imported_data"]));
  });
  it("omits owner import actions when scoped Run credentials are present", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "owner-test-token"); vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    await createIpcServer({} as MatrixDB);
    const config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map(tool => tool.name)).not.toContain("refresh_imported_data");
  });
});

describe("IPC document tool registration", () => {
  afterEach(() => vi.clearAllMocks());
  const names = (): string[] =>
    (sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);

  // Fault detected: the chat agent is offered document tools with no document service behind them.
  it("omits document tools when the gateway injects no document service", async () => {
    await createIpcServer({} as MatrixDB, "/home/matrix/home");
    expect(names().filter(name => name.startsWith("document_") || name.startsWith("sheet_"))).toEqual([]);
  });

  // Fault detected: an injected document service never reaches the chat agent.
  it("registers every document and sheet tool when the document service is injected", async () => {
    await createIpcServer({} as MatrixDB, "/home/matrix/home", undefined, undefined, undefined, { request: vi.fn() });
    expect(names()).toEqual(expect.arrayContaining([
      "document_describe", "document_read_text", "document_propose_edits", "document_list_revisions",
      "document_accept_revisions", "document_reject_revisions", "document_add_comment", "document_compare",
      "document_create", "sheet_describe", "sheet_read_range", "sheet_propose_edits", "sheet_list_changes",
      "sheet_accept_changes", "sheet_reject_changes",
    ]));
  });
});
