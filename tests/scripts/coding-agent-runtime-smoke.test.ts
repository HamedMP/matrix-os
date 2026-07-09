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

function reviewSummary() {
  return {
    id: "review_smoke",
    projectId: "project-smoke",
    worktreeId: "wt_123456789abc",
    status: "reviewing",
    pullRequestNumber: 874,
    round: 1,
    maxRounds: 3,
    reviewer: "codex",
    implementer: "codex",
    findings: { total: 1, high: 0, medium: 1, low: 0 },
    updatedAt: NOW,
  };
}

function smokeFetch(options: {
  summary?: Record<string, unknown>;
  reviews?: unknown[];
} = {}) {
  return vi.fn(async (input: string) => {
    if (input.endsWith("/api/coding-agents/summary")) return jsonResponse(runtimeSummary(options.summary ?? {}));
    if (input.endsWith("/api/coding-agents/notification-preferences")) {
      return jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } } });
    }
    if (input.endsWith("/api/coding-agents/reviews")) {
      return jsonResponse({ items: options.reviews ?? [], hasMore: false, limit: 50 });
    }
    if (input.endsWith("/api/coding-agents/threads/thread_smoke_1")) return jsonResponse(threadSnapshot());
    throw new Error(`unexpected request ${input}`);
  });
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
      parseArgs([
        "--",
        "--origin",
        "https://app.matrix-os.com",
        "--json",
        "--require-capability",
        "codingAgentsPreview",
        "--require-capability",
        "codingAgentsFiles",
        "--require-ready-provider",
        "--require-thread-snapshot",
        "--min-active-threads",
        "1",
        "--min-terminal-sessions",
        "1",
        "--min-preview-sessions",
        "1",
        "--min-reviews",
        "1",
      ], {
        MATRIX_CODING_AGENTS_SMOKE_TOKEN: "secret-token",
      }),
    ).toMatchObject({
      origin: "https://app.matrix-os.com",
      token: "secret-token",
      json: true,
      createThread: false,
      requiredCapabilities: ["codingAgentsPreview", "codingAgentsFiles"],
      requireReadyProvider: true,
      requireThreadSnapshot: true,
      minActiveThreads: 1,
      minTerminalSessions: 1,
      minPreviewSessions: 1,
      minReviews: 1,
    });
  });

  it("rejects unsafe assertion arguments before making requests", () => {
    expect(() =>
      parseArgs(["--origin", "https://app.matrix-os.com", "--require-capability", "codingAgentsSecrets"], {
        MATRIX_CODING_AGENTS_SMOKE_TOKEN: "secret-token",
      }),
    ).toThrow("Invalid required capability");

    for (const value of ["-1", "0"]) {
      expect(() =>
        parseArgs(["--origin", "https://app.matrix-os.com", "--min-active-threads", value], {
          MATRIX_CODING_AGENTS_SMOKE_TOKEN: "secret-token",
        }),
      ).toThrow("min-active-threads must be a positive integer up to 1000");
    }
  });

  it("requires bearer tokens through the environment instead of CLI args", () => {
    expect(() => parseArgs(["--origin", "https://app.matrix-os.com", "--token", "secret-token"], {}))
      .toThrow(/Unknown argument: --token/);

    expect(() => parseArgs(["--origin", "https://app.matrix-os.com"], {}))
      .toThrow("Missing MATRIX_CODING_AGENTS_SMOKE_TOKEN");
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
    expect(report.summary.assertionsChecked).toBe(0);
    expect(fetchFn.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });

  it("checks requested capability and count assertions against the live summary", async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.endsWith("/api/coding-agents/summary")) {
        return jsonResponse(runtimeSummary({
          capabilities: [
            { id: "codingAgentsRuntimeSummary", enabled: true },
            { id: "codingAgentsPreview", enabled: true },
            { id: "codingAgentsFiles", enabled: true },
          ],
          previewSessions: {
            items: [
              {
                id: "preview_smoke",
                label: "Smoke preview",
                status: "running",
                origin: "https://preview.example.com",
                updatedAt: NOW,
              },
            ],
            hasMore: false,
            limit: 50,
          },
        }));
      }
      if (input.endsWith("/api/coding-agents/notification-preferences")) {
        return jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } } });
      }
      if (input.endsWith("/api/coding-agents/reviews")) {
        return jsonResponse({ items: [reviewSummary()], hasMore: false, limit: 50 });
      }
      if (input.endsWith("/api/coding-agents/threads/thread_smoke_1")) return jsonResponse(threadSnapshot());
      throw new Error(`unexpected request ${input}`);
    });

    const report = await runCodingAgentRuntimeSmoke({
      origin: "https://app.matrix-os.com",
      token: "secret-token",
      fetchFn,
      timeoutMs: 1000,
      requiredCapabilities: ["codingAgentsPreview", "codingAgentsFiles"],
      requireReadyProvider: true,
      requireThreadSnapshot: true,
      minActiveThreads: 1,
      minTerminalSessions: 1,
      minPreviewSessions: 1,
      minReviews: 1,
    });

    expect(report.summary.assertionsChecked).toBe(8);
  });

  it("fails with generic messages when required capabilities are disabled", async () => {
    await expect(
      runCodingAgentRuntimeSmoke({
        origin: "https://app.matrix-os.com",
        token: "secret-token",
        fetchFn: smokeFetch({
          summary: {
            capabilities: [
              { id: "codingAgentsRuntimeSummary", enabled: true },
              { id: "codingAgentsPreview", enabled: false, reason: "Not enabled yet" },
            ],
          },
        }),
        timeoutMs: 1000,
        requiredCapabilities: ["codingAgentsPreview"],
      }),
    ).rejects.toThrow("coding-agent runtime requirements unavailable");
  });

  it("fails with generic messages when a ready provider is required but unavailable", async () => {
    await expect(
      runCodingAgentRuntimeSmoke({
        origin: "https://app.matrix-os.com",
        token: "secret-token",
        fetchFn: smokeFetch({ summary: { providers: [] } }),
        timeoutMs: 1000,
        requireReadyProvider: true,
      }),
    ).rejects.toThrow("coding-agent runtime requirements unavailable");
  });

  it("fails with generic messages when an existing thread snapshot is required but unavailable", async () => {
    await expect(
      runCodingAgentRuntimeSmoke({
        origin: "https://app.matrix-os.com",
        token: "secret-token",
        fetchFn: smokeFetch({
          summary: {
            activeThreads: { items: [], hasMore: false, limit: 50 },
            attentionThreads: { items: [], hasMore: false, limit: 50 },
          },
        }),
        timeoutMs: 1000,
        requireThreadSnapshot: true,
      }),
    ).rejects.toThrow("coding-agent runtime requirements unavailable");
  });

  it.each([
    [
      "active threads",
      { activeThreads: { items: [], hasMore: false, limit: 50 } },
      { minActiveThreads: 1 },
      [],
    ],
    [
      "terminal sessions",
      { terminalSessions: { items: [], hasMore: false, limit: 50 } },
      { minTerminalSessions: 1 },
      [],
    ],
    [
      "preview sessions",
      { previewSessions: { items: [], hasMore: false, limit: 50 } },
      { minPreviewSessions: 1 },
      [],
    ],
    [
      "reviews",
      {},
      { minReviews: 1 },
      [],
    ],
  ])("fails with generic messages when minimum %s are unmet", async (_label, summary, minimums, reviews) => {
    await expect(
      runCodingAgentRuntimeSmoke({
        origin: "https://app.matrix-os.com",
        token: "secret-token",
        fetchFn: smokeFetch({ summary, reviews }),
        timeoutMs: 1000,
        ...minimums,
      }),
    ).rejects.toThrow("coding-agent runtime requirements unavailable");
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
