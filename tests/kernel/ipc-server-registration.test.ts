import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixDB } from "../../packages/kernel/src/db.js";
import { createIpcServer } from "../../packages/kernel/src/ipc-server.js";

const sdk = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((config: unknown) => config),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: unknown, _extras?: unknown) => ({ name, handler })),
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

  it("registers brain_why only when the gateway injects brain tools", async () => {
    await createIpcServer(db, "/home/matrix/home");
    const without = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(without.tools.map((registered) => registered.name)).not.toContain("brain_why");

    const why = vi.fn(async () => ({ status: "not_found" as const }));
    await createIpcServer(db, "/home/matrix/home", undefined, undefined, { why });
    type Registered = { name: string; handler: (input: unknown) => Promise<unknown> };
    const withTools = sdk.createSdkMcpServer.mock.calls[1]?.[0] as { tools: Registered[] };
    const brainWhy = withTools.tools.find((registered) => registered.name === "brain_why");
    expect(sdk.tool.mock.calls.find((call) => call[0] === "brain_why")?.[4]).toEqual({ annotations: { readOnlyHint: true } });
    await expect(brainWhy?.handler({ project: "widgets", path: "src/" })).resolves.toEqual({
      content: [{ type: "text", text: "That project was not found." }],
    });
    expect(why).toHaveBeenCalledWith({ project: "widgets", path: "src/", limit: 5, detail: "brief" });
  });

  it("registers a read-only brain read tool for each injected method only", async () => {
    const search = vi.fn(async () => ({ status: "not_found" as const }));
    await createIpcServer(db, "/home/matrix/home", undefined, undefined, undefined, { search });
    const config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    const names = config.tools.map((registered) => registered.name);
    expect(names).toContain("brain_search");
    expect(names).not.toContain("brain_impact");
    expect(names).not.toContain("brain_why");
    expect(sdk.tool.mock.calls.find((call) => call[0] === "brain_search")?.[4]).toEqual({ annotations: { readOnlyHint: true } });
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
