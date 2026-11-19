import { fetchThreadTerminalSession } from "@/lib/requests/coding-agent-threads";

const GATEWAY_URL = "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1";
const THREAD_ID = "thread_mobile_attention";
const WORKSPACE = "tws_00000000000000000000000000000001";
const TAB = "tt_0000000000000000000000000000000a";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function snapshot(thread: Record<string, unknown>) {
  // Only the summary is read; the events stay unparsed so a newer event kind
  // on the computer cannot stop the lookup.
  return {
    thread: { id: THREAD_ID, providerId: "codex", title: "Fix the build", status: "waiting", ...thread },
    events: { items: [{ type: "event.from.a.newer.gateway" }], hasMore: false, limit: 50 },
  };
}

describe("fetchThreadTerminalSession", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("names the terminal tab the thread runs in, as the terminal screen does", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(
      snapshot({ terminalRef: { workspaceId: WORKSPACE, tabId: TAB } }),
    ));

    await expect(fetchThreadTerminalSession("clerk-token", GATEWAY_URL, THREAD_ID, 1_500))
      .resolves.toBe(`${WORKSPACE}:${TAB}`);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/vm/solar-vale/api/coding-agents/threads/${THREAD_ID}?runtime=preview-1`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
        signal: expect.any(Object),
      }),
    );
  });

  it("reports no terminal for a thread that runs in none", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(snapshot({})));

    await expect(fetchThreadTerminalSession("clerk-token", GATEWAY_URL, THREAD_ID)).resolves.toBeNull();
  });

  it("refuses a terminal reference that is not one", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(
      snapshot({ terminalRef: { workspaceId: "../main", tabId: TAB } }),
    ));

    await expect(fetchThreadTerminalSession("clerk-token", GATEWAY_URL, THREAD_ID)).rejects.toThrow("Thread unavailable.");
  });

  it("fails without naming the computer's error", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Thread not found" }, 404));

    await expect(fetchThreadTerminalSession("clerk-token", GATEWAY_URL, THREAD_ID)).rejects.toThrow("Thread unavailable.");
  });

  it("never asks for an id that is not a thread's", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(fetchThreadTerminalSession("clerk-token", GATEWAY_URL, "../settings")).rejects.toThrow("Thread unavailable.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
