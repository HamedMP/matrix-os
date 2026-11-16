import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAgentRoutes } from "../../packages/gateway/src/terminal-agent/routes.js";
import { TerminalAgentVerbError, type TerminalAgentVerbs } from "../../packages/gateway/src/terminal-agent/verbs.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const base = `/api/terminal/workspaces/${workspaceId}/tabs/${tabId}`;

function app(options: {
  verbs?: Partial<TerminalAgentVerbs>;
  userId?: string;
  withWorkspace?: ReturnType<typeof vi.fn>;
  waiter?: { wait: ReturnType<typeof vi.fn>; shutdown: () => void };
} = {}) {
  const verbs: TerminalAgentVerbs = {
    get: vi.fn(async () => ({ tab: { id: tabId } as never, state: "live" as const })),
    read: vi.fn(async () => ({ screen: "ok", history: "", lines: 0 })),
    send: vi.fn(async () => ({ sent: true as const, heldMs: 0 })),
    keys: vi.fn(async () => ({ pressed: 1 })),
    interrupt: vi.fn(async () => ({ pressed: "ctrl+c" as const })),
    ...options.verbs,
  };
  const withWorkspace = options.withWorkspace
    ?? vi.fn(async (_owner: string, _workspace: string, _kind: string, operation: () => Promise<unknown>) => operation());
  const hono = new Hono();
  hono.route("/api/terminal", createTerminalAgentRoutes({
    verbs,
    ...(options.waiter ? { waiter: options.waiter as never } : {}),
    getPrincipal: () => ({ userId: options.userId ?? "user_owner", source: "jwt" as const }),
    terminalOwnerIds: ["user_owner"],
    projectAdmission: { withWorkspace, withProject: vi.fn() } as never,
  }));
  return { hono, verbs, withWorkspace };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("terminal agent routes", () => {
  // Fault detected: another user's principal can read or type into the owner's terminals.
  it("hides every verb from a principal that is not the terminal owner", async () => {
    const { hono, verbs } = app({ userId: "user_other" });
    for (const [path, init] of [
      [`${base}`, undefined],
      [`${base}/read?lines=10`, undefined],
      [`${base}/send`, post({ text: "hi" })],
      [`${base}/keys`, post({ keys: ["enter"] })],
      [`${base}/interrupt`, post({})],
    ] as const) {
      const response = await hono.request(path, init);
      expect(response.status, path).toBe(404);
    }
    expect(verbs.read).not.toHaveBeenCalled();
    expect(verbs.send).not.toHaveBeenCalled();
  });

  it("reads with a validated line count", async () => {
    const { hono, verbs } = app();
    const response = await hono.request(`${base}/read?lines=50`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ screen: "ok", history: "", lines: 0 });
    expect(verbs.read).toHaveBeenCalledWith({ workspaceId, tabId }, { lines: 50 });
    expect((await hono.request(`${base}/read`)).status).toBe(200);
    expect(verbs.read).toHaveBeenLastCalledWith({ workspaceId, tabId }, { lines: 0 });
    for (const lines of ["-1", "10001", "abc", "1.5"]) {
      expect((await hono.request(`${base}/read?lines=${lines}`)).status, lines).toBe(400);
    }
    expect((await hono.request(`/api/terminal/workspaces/../tabs/${tabId}/read`)).status).toBe(404);
  });

  it("runs sends inside workspace admission with a strict body", async () => {
    const { hono, verbs, withWorkspace } = app();
    const response = await hono.request(`${base}/send`, post({ text: "review x.ts", force: true }));
    expect(response.status).toBe(200);
    expect(withWorkspace).toHaveBeenCalledWith("user_owner", workspaceId, "run", expect.any(Function));
    // The request's abort signal goes along, so a held send is dropped if the caller leaves.
    expect(verbs.send).toHaveBeenCalledWith({ workspaceId, tabId }, { text: "review x.ts", force: true, signal: expect.any(AbortSignal) });
    expect((await hono.request(`${base}/send`, post({ text: "x", maxHoldMs: 61_000 }))).status).toBe(400);
    expect((await hono.request(`${base}/send`, post({ text: "x", extra: 1 }))).status).toBe(400);
    expect((await hono.request(`${base}/send`, post({ text: "x".repeat(8193) }))).status).toBe(400);
    expect((await hono.request(`${base}/keys`, post({ keys: Array(65).fill("enter") }))).status).toBe(400);
  });

  it("rejects bodies above the limit before parsing them", async () => {
    const { hono, verbs } = app();
    const response = await hono.request(`${base}/send`, post({ text: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect(verbs.send).not.toHaveBeenCalled();
  });

  // Fault detected: clients cannot tell "the agent needs a person" from a server failure.
  it("maps typed verb errors to stable codes without internal detail", async () => {
    const cases: Array<[TerminalAgentVerbError | Error, number, string]> = [
      [new TerminalAgentVerbError("blocked"), 409, "terminal_agent_blocked"],
      [new TerminalAgentVerbError("finished"), 409, "terminal_finished"],
      [new TerminalAgentVerbError("not_found"), 404, "Terminal operation failed"],
      [new TerminalAgentVerbError("invalid_request"), 400, "Invalid request"],
      [new Error("zellij exploded at /home/matrix/secret"), 500, "Terminal operation failed"],
    ];
    for (const [error, status, message] of cases) {
      const { hono } = app({ verbs: { send: vi.fn(async () => { throw error; }) } });
      const response = await hono.request(`${base}/send`, post({ text: "hi" }));
      expect(response.status, message).toBe(status);
      const body = await response.json() as { error: string };
      expect(body.error).toBe(message);
      expect(JSON.stringify(body)).not.toContain("secret");
    }
  });

  // Fault detected: a long wait outlives its caller, or an unbounded wait ties up the gateway.
  it("waits with a bounded timeout and cancels when the caller disconnects", async () => {
    const wait = vi.fn(async (_ref: unknown, input: { signal?: AbortSignal }) => {
      expect(input.signal).toBeInstanceOf(AbortSignal);
      return { reason: "stopped", status: "done" };
    });
    const { hono } = app({ waiter: { wait, shutdown: () => undefined } });
    const response = await hono.request(`${base}/wait`, post({ timeoutMs: 30_000, output: "ready" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reason: "stopped", status: "done" });
    expect(wait).toHaveBeenCalledWith({ workspaceId, tabId }, expect.objectContaining({ timeoutMs: 30_000, output: "ready" }));
    expect((await hono.request(`${base}/wait`, post({ timeoutMs: 600_000 }))).status).toBe(400);
    expect((await hono.request(`${base}/wait`, post({ output: "x".repeat(257) }))).status).toBe(400);
  });

  it("reports wait capacity and a missing waiter as distinct server states", async () => {
    const { TerminalWaitCapacityError } = await import("../../packages/gateway/src/terminal-agent/wait.js");
    const busy = app({ waiter: { wait: vi.fn(async () => { throw new TerminalWaitCapacityError(); }), shutdown: () => undefined } });
    expect((await busy.hono.request(`${base}/wait`, post({}))).status).toBe(429);
    const missing = app();
    expect((await missing.hono.request(`${base}/wait`, post({}))).status).toBe(503);
  });
});
