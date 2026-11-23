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

describe("IPC project task registration", () => {
  afterEach(() => vi.clearAllMocks());
  const session = { projectId: "proj_alpha", projectSlug: "matrix-os", taskId: "task_42" };
  const client = Object.fromEntries(["listTasks", "getTask", "createTask", "updateTask", "moveTask", "listComments", "createComment", "listActivity", "startTask"]
    .map((method) => [method, vi.fn()])) as never;

  // Fault detected: a kernel run inside a task could not read or update its own board.
  it("registers the board tools only when the run carries a project binding", async () => {
    await createIpcServer({} as MatrixDB, "/home/matrix/home");
    let config = sdk.createSdkMcpServer.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map((registered) => registered.name)).not.toContain("project_task_list");

    await createIpcServer({} as MatrixDB, "/home/matrix/home", undefined, undefined, undefined, { client, session });
    config = sdk.createSdkMcpServer.mock.calls[1]?.[0] as { tools: Array<{ name: string }> };
    expect(config.tools.map((registered) => registered.name)).toEqual(expect.arrayContaining([
      "project_task_list", "project_task_get", "project_task_create", "project_task_update",
      "project_task_move", "project_task_comment", "project_task_start", "list_tasks",
    ]));
  });

  it("fails at registration when the binding is incomplete", async () => {
    await expect(createIpcServer({} as MatrixDB, "/home/matrix/home", undefined, undefined, undefined,
      { client: { ...(client as object), startTask: undefined } as never, session })).rejects.toThrow();
  });
});
