import { describe, expect, it, vi } from "vitest";
import { createCodingSessionClient } from "../../src/cli/tui/coding-sessions.js";

describe("TUI coding session client", () => {
  it("uses workspace session routes for list, get, create, send, observe, takeover, and kill", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const gateway = {
      requestJson: vi.fn(async (path: string, init?: RequestInit) => {
        calls.push([path, init]);
        if (path.startsWith("/api/sessions?")) return { sessions: [{ id: "sess_abc123", agent: "codex", runtime: { status: "running" } }], nextCursor: null };
        if (path === "/api/sessions/sess_abc123/observe") return { mode: "observe", terminalSessionId: "term_1" };
        if (path === "/api/sessions/sess_abc123/takeover") return { mode: "owner", terminalSessionId: "term_2" };
        if (path === "/api/sessions/sess_abc123/send") return { session: { id: "sess_abc123" } };
        if (path === "/api/sessions/sess_abc123") return init?.method === "DELETE" ? { session: { id: "sess_abc123" } } : { session: { id: "sess_abc123" } };
        return { session: { id: "sess_new" } };
      }),
    };
    const client = createCodingSessionClient(gateway);

    await expect(client.list({ projectSlug: "repo", limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "sess_abc123", kind: "agent" })]);
    await client.get("sess_abc123");
    await client.create({ projectSlug: "repo", worktreeId: "wt_1", kind: "agent", agent: "codex", prompt: "fix tests" });
    await client.send("sess_abc123", "pnpm test\n");
    await expect(client.observe("sess_abc123")).resolves.toMatchObject({ mode: "observe", terminalSessionId: "term_1" });
    await expect(client.takeover("sess_abc123")).resolves.toMatchObject({ mode: "owner", terminalSessionId: "term_2" });
    await client.kill("sess_abc123");

    expect(calls.map(([path]) => path)).toEqual([
      "/api/sessions?projectSlug=repo&limit=10",
      "/api/sessions/sess_abc123",
      "/api/sessions",
      "/api/sessions/sess_abc123/send",
      "/api/sessions/sess_abc123/observe",
      "/api/sessions/sess_abc123/takeover",
      "/api/sessions/sess_abc123",
    ]);
    expect(calls[1][1]?.method ?? "GET").toBe("GET");
    expect(calls[2][1]).toMatchObject({ method: "POST" });
    expect(calls[6][1]).toMatchObject({ method: "DELETE" });
  });
});
