import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeUrl,
  parseArgs,
  runCodingAgentRuntimeSmoke,
} from "../../scripts/coding-agent-runtime-smoke";

const NOW = "2026-07-09T00:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runtimeSummary(overrides: Record<string, unknown> = {}) {
  return {
    runtime: {
      id: "rt_smoke",
      label: "Smoke runtime",
      status: "available",
    },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsThreadCreate", enabled: true },
    ],
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        kind: "codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: NOW,
      },
    ],
    projects: { items: [], hasMore: false, limit: 50 },
    activeThreads: {
      items: [
        {
          id: "thread_smoke_1",
          providerId: "codex",
          title: "Smoke thread",
          status: "running",
          attention: "none",
          terminalSessionId: "matrix-smoke",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      hasMore: false,
      limit: 50,
    },
    attentionThreads: { items: [], hasMore: false, limit: 50 },
    terminalSessions: {
      items: [
        {
          id: "matrix-smoke",
          name: "Matrix smoke",
          status: "running",
          attachable: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      hasMore: false,
      limit: 50,
    },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 100 },
    limits: {
      maxPromptBytes: 96 * 1024,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 64 * 1024,
      maxListItems: 50,
    },
    serverTime: NOW,
    ...overrides,
  };
}

function threadSnapshot(threadId = "thread_smoke_1") {
  return {
    thread: {
      id: threadId,
      providerId: "codex",
      title: "Smoke thread",
      status: "completed",
      attention: "completed",
      terminalSessionId: "matrix-smoke",
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: {
      items: [
        {
          type: "thread.completed",
          eventId: "evt_smoke_completed",
          threadId,
          occurredAt: NOW,
          outcome: "completed",
        },
      ],
      hasMore: false,
      limit: 200,
    },
  };
}

describe("coding-agent runtime smoke", () => {
  it("builds runtime URLs without leaking the token into query params", () => {
    const url = buildRuntimeUrl({
      origin: "https://app.matrix-os.com/vm/demo",
      path: "/api/coding-agents/summary",
      runtime: "secondary",
    });

    expect(url.toString()).toBe("https://app.matrix-os.com/api/coding-agents/summary?runtime=secondary");
    expect(url.toString()).not.toContain("secret-token");
  });

  it("parses args from flags and environment", () => {
    expect(
      parseArgs(["--", "--origin", "https://app.matrix-os.com", "--json"], {
        MATRIX_CODING_AGENTS_SMOKE_TOKEN: "secret-token",
      }),
    ).toMatchObject({
      origin: "https://app.matrix-os.com",
      token: "secret-token",
      json: true,
      createThread: false,
    });
  });

  it("runs read-only smoke by default and validates shared contracts", async () => {
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer secret-token" }));
      if (input.endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary());
      if (input.endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } } });
      }
      if (input.endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [], hasMore: false, limit: 50 });
      }
      if (input.endsWith("/api/coding-agents/threads/thread_smoke_1")) return jsonResponse(threadSnapshot());
      throw new Error(`unexpected request ${input}`);
    });

    const report = await runCodingAgentRuntimeSmoke({
      origin: "https://app.matrix-os.com",
      token: "secret-token",
      fetchFn,
      timeoutMs: 1000,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.activeThreadCount).toBe(1);
    expect(report.summary.createdThreadStatus).toBeNull();
    expect(fetchFn.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });

  it("can create a thread only when explicitly requested", async () => {
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary({ activeThreads: { items: [], hasMore: false, limit: 50 } }));
      if (input.endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } } });
      }
      if (input.endsWith("/api/coding-agents/reviews")) return jsonResponse({ items: [], hasMore: false, limit: 50 });
      if (input.endsWith("/api/coding-agents/threads")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          providerId: "codex",
          prompt: "run smoke",
        });
        expect(body.clientRequestId).toMatch(/^req_/);
        return jsonResponse(threadSnapshot("thread_created_smoke"));
      }
      throw new Error(`unexpected request ${input}`);
    });

    const report = await runCodingAgentRuntimeSmoke({
      origin: "https://app.matrix-os.com",
      token: "secret-token",
      createThread: true,
      prompt: "run smoke",
      fetchFn,
      timeoutMs: 1000,
    });

    expect(report.summary.createdThreadStatus).toBe("completed");
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("returns generic failures for invalid runtime payloads", async () => {
    await expect(
      runCodingAgentRuntimeSmoke({
        origin: "https://app.matrix-os.com",
        token: "secret-token",
        fetchFn: vi.fn(async () => jsonResponse({ error: "/home/matrix/private" })),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("runtime summary unavailable");
  });
});
