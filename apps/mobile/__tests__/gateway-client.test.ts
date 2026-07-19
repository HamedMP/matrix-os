import {
  GatewayClient,
  DEFAULT_GATEWAY_FETCH_TIMEOUT_MS,
  assertSecureTokenTransport,
} from "../lib/gateway-client";
import type { AgentThreadEvent, CreateAgentThreadRequest, CreateAgentTurnRequest } from "@matrix-os/contracts";
import { jsonResponse } from "./mobile-shell-test-utils";

function reviewSnapshotPayload(id = "rev_mobile_1") {
  return {
    review: {
      id,
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      status: "reviewing",
      pullRequestNumber: 757,
      round: 1,
      maxRounds: 3,
      reviewer: "codex",
      implementer: "claude",
      findings: {
        total: 1,
        high: 1,
        medium: 0,
        low: 0,
      },
      updatedAt: "2026-07-06T00:00:00.000Z",
    },
    files: {
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
          partial: true,
          hunks: [],
          findings: [
            {
              id: "HIGH-1",
              severity: "high",
              line: 42,
              summary: "Validate ownership before returning snapshots.",
            },
          ],
        },
      ],
      hasMore: false,
      limit: 100,
    },
    partial: true,
    safeNotice: "Diff content is not available yet. Showing bounded review findings.",
    updatedAt: "2026-07-06T00:00:00.000Z",
  };
}

function fileReadPayload() {
  return {
    metadata: {
      path: "packages/gateway/src/coding-agents/routes.ts",
      kind: "file",
      sizeBytes: 37,
      etag: "sha256_mobile_file",
      updatedAt: "2026-07-06T00:03:00.000Z",
    },
    content: "export const safeRoute = true;\n",
    encoding: "utf8",
    truncated: false,
    limitBytes: 65536,
  };
}

function fileBrowsePayload() {
  return {
    directory: {
      path: "packages",
      kind: "directory",
      updatedAt: "2026-07-06T00:03:00.000Z",
    },
    entries: {
      items: [
        {
          path: "packages/gateway",
          kind: "directory",
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
        {
          path: "packages/README.md",
          kind: "file",
          sizeBytes: 24,
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
  };
}

function fileSearchPayload() {
  return {
    matches: {
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          kind: "file",
          sizeBytes: 37,
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
  };
}

function fileWritePayload() {
  return {
    metadata: {
      path: "packages/gateway/src/coding-agents/routes.ts",
      kind: "file",
      sizeBytes: 38,
      etag: "sha256_mobile_file_next",
      updatedAt: "2026-07-06T00:04:00.000Z",
    },
    encoding: "utf8",
    writtenBytes: 38,
  };
}

function sourceCommitPayload() {
  return {
    status: "committed",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    branch: "feature/review-fix",
    changedFileCount: 1,
    safeMessage: "Changes were committed.",
  };
}

function sourcePullRequestPayload() {
  return {
    status: "created",
    number: 808,
    url: "https://github.com/HamedMP/matrix-os/pull/808",
    headBranch: "feature/review-fix",
    baseBranch: "main",
    safeMessage: "Pull request is ready for review.",
  };
}

describe("GatewayClient", () => {
  it("initializes with disconnected state", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.connectionState).toBe("disconnected");
  });

  it("derives HTTP URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("derives WS URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.wsUrl).toBe("ws://localhost:4000/ws");
  });

  it("converts https to wss", () => {
    const client = new GatewayClient("https://my.gateway.com");
    expect(client.wsUrl).toBe("wss://my.gateway.com/ws");
  });

  it("strips trailing slashes from base URL", () => {
    const client = new GatewayClient("http://localhost:4000///");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("keeps path joins valid for a routed computer URL with a runtime query", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    const client = new GatewayClient("https://app.matrix-os.com/vm/pr-919?runtime=pr-919");

    expect(client.httpUrl).toBe("https://app.matrix-os.com/vm/pr-919");

    await client.healthCheck();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/pr-919/health?runtime=pr-919",
      expect.anything(),
    );

    fetchMock.mockRestore();
  });

  it("keeps primary computer URLs without a runtime query untouched", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    const client = new GatewayClient("https://app.matrix-os.com/vm/neo");

    expect(client.httpUrl).toBe("https://app.matrix-os.com/vm/neo");

    await client.healthCheck();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/neo/health",
      expect.anything(),
    );

    fetchMock.mockRestore();
  });

  it("routes websockets for hosted computers through the canonical platform origin", () => {
    const routed = new GatewayClient("https://app.matrix-os.com/vm/pr-919?runtime=pr-919");
    expect(routed.wsUrl).toBe("wss://app.matrix-os.com/ws?runtime=pr-919");
    expect(routed.terminalWsUrl).toBe("wss://app.matrix-os.com/ws/terminal/session?runtime=pr-919");

    const primary = new GatewayClient("https://app.matrix-os.com/vm/neo");
    expect(primary.wsUrl).toBe("wss://app.matrix-os.com/ws");

    const selfHosted = new GatewayClient("https://matrix.example.test");
    expect(selfHosted.wsUrl).toBe("wss://matrix.example.test/ws");
  });

  it("parses conversation lists and tolerates invalid payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([
      { id: "conv-1", preview: "Fix the tests", messageCount: 4, createdAt: 1, updatedAt: 2 },
    ]));
    const client = new GatewayClient("http://localhost:4000");

    await expect(client.getConversations()).resolves.toEqual([
      expect.objectContaining({ id: "conv-1", preview: "Fix the tests", messageCount: 4 }),
    ]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "misconfigured" } }));
    await expect(client.getConversations()).resolves.toEqual([]);

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED /var/secret"));
    await expect(client.getConversations()).resolves.toEqual([]);

    fetchMock.mockRestore();
  });

  it("truncates oversized conversation lists to the first 50 entries", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `conv-${i}`,
      preview: `Conversation ${i}`,
      messageCount: i,
      createdAt: i,
      updatedAt: i,
    }));
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(many));
    const client = new GatewayClient("http://localhost:4000");

    const result = await client.getConversations();
    expect(result).toHaveLength(50);
    expect(result[0]).toEqual(expect.objectContaining({ id: "conv-0" }));
    expect(result[49]).toEqual(expect.objectContaining({ id: "conv-49" }));

    fetchMock.mockRestore();
  });

  it("drops malformed conversation entries but keeps the valid ones", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([
      { id: "conv-1", preview: "ok", messageCount: 1, createdAt: 1, updatedAt: 2 },
      { id: "", preview: "empty id", messageCount: 1, createdAt: 1, updatedAt: 2 },
      { preview: "missing id", messageCount: 1, createdAt: 1, updatedAt: 2 },
      { id: "conv-2", preview: "ok too", messageCount: 2, createdAt: 3, updatedAt: 4 },
    ]));
    const client = new GatewayClient("http://localhost:4000");

    await expect(client.getConversations()).resolves.toEqual([
      expect.objectContaining({ id: "conv-1" }),
      expect.objectContaining({ id: "conv-2" }),
    ]);

    fetchMock.mockRestore();
  });

  it("creates a conversation and returns its id", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ id: "conv-new" }));
    const client = new GatewayClient("http://localhost:4000");

    await expect(client.createConversation()).resolves.toBe("conv-new");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/conversations",
      expect.objectContaining({ method: "POST" }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ nope: true }));
    await expect(client.createConversation()).resolves.toBeNull();

    fetchMock.mockRestore();
  });

  it("fetches the websocket token from the platform origin for hosted computers", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ token: "jwt-token", expiresAt: Date.now() + 60_000 }),
    );
    const client = new GatewayClient("https://app.matrix-os.com/vm/pr-919?runtime=pr-919");

    await client.getWsToken();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/auth/ws-token?runtime=pr-919",
      expect.anything(),
    );

    fetchMock.mockRestore();
  });

  it("allows only local self-hosted token transport over HTTP and keeps Matrix OS Cloud HTTPS-only", () => {
    expect(() => new GatewayClient("https://app.matrix-os.com", "token")).not.toThrow();
    expect(() => new GatewayClient("http://localhost:4000", "token")).not.toThrow();
    expect(() => new GatewayClient("http://127.0.0.1:4000", "token")).not.toThrow();
    expect(() => new GatewayClient("http://[::1]:4000", "token")).not.toThrow();
    expect(() => new GatewayClient("http://192.168.1.10:4000", "token")).not.toThrow();
    expect(() => new GatewayClient("http://203.0.113.10:4000", "token")).toThrow(
      "Self-hosted gateways with saved credentials require HTTPS/WSS unless they are local.",
    );
    expect(() => new GatewayClient("http://app.matrix-os.com", "token")).toThrow(
      "Matrix OS Cloud requires HTTPS/WSS.",
    );
  });

  it("rejects insecure Matrix OS Cloud URLs for deferred token sources", () => {
    const getToken = jest.fn<Promise<string | null>, []>().mockResolvedValue("token");
    expect(() => new GatewayClient("http://app.matrix-os.com", getToken)).toThrow(
      "Matrix OS Cloud requires HTTPS/WSS.",
    );
  });

  it("rejects websocket query tokens over insecure Matrix OS Cloud URLs", () => {
    const client = new GatewayClient("http://app.matrix-os.com");
    expect(() => client.setWebSocketToken("ws-token")).toThrow(
      "Matrix OS Cloud requires HTTPS/WSS.",
    );
  });

  it("validates standalone gateway token transport URLs", () => {
    expect(() => assertSecureTokenTransport("wss://app.matrix-os.com")).not.toThrow();
    expect(() => assertSecureTokenTransport("ws://app.matrix-os.com")).toThrow(
      "Matrix OS Cloud requires HTTPS/WSS.",
    );
    expect(() => assertSecureTokenTransport("ws://192.168.1.10:4000")).not.toThrow();
    expect(() => assertSecureTokenTransport("ws://203.0.113.10:4000")).toThrow(
      "Self-hosted gateways with saved credentials require HTTPS/WSS unless they are local.",
    );
  });

  it("registers message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("registers state change handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onStateChange(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unsubscribes message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    unsub();
    // handler should no longer be registered
  });

  it("reports isConnected as false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.isConnected).toBe(false);
  });

  it("sendMessage returns false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.sendMessage("hello")).toBe(false);
  });

  it("send returns false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.send({ type: "message", text: "test" })).toBe(false);
  });

  it("opens native websocket connections with bearer headers", () => {
    const OriginalWebSocket = global.WebSocket;
    const webSocketMock = jest.fn().mockImplementation(() => ({
      readyState: 0,
      close: jest.fn(),
    }));
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    client.connect();

    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.com/ws",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    global.WebSocket = OriginalWebSocket;
  });

  it("uses platform websocket tokens in the upgrade URL when present", () => {
    const OriginalWebSocket = global.WebSocket;
    const webSocketMock = jest.fn().mockImplementation(() => ({
      readyState: 0,
      close: jest.fn(),
    }));
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token", "ws-token");
    client.connect();

    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.com/ws?token=ws-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    global.WebSocket = OriginalWebSocket;
  });

  it("subscribes to bounded coding-agent thread stream events", async () => {
    const OriginalWebSocket = global.WebSocket;
    const events: AgentThreadEvent[] = [];
    type StreamSocketMock = {
      readyState: number;
      sent: string[];
      closed: boolean;
      send: jest.Mock;
      close: jest.Mock;
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
    };
    const sockets: StreamSocketMock[] = [];
    const webSocketMock = jest.fn().mockImplementation(() => {
      let socket!: StreamSocketMock;
      socket = {
        readyState: 0,
        sent: [],
        closed: false,
        send: jest.fn((frame: string) => socket.sent.push(frame)),
        close: jest.fn(() => {
          socket.closed = true;
          socket.readyState = 3;
        }),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      sockets.push(socket);
      return socket;
    });
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      token: "stream-token",
      expiresAt: Date.now() + 300_000,
    }));

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    const subscription = await client.subscribeCodingAgentThreadEvents({
      threadId: "thread_mobile",
      onEvent: (event) => events.push(event),
    });

    expect(subscription).not.toBeNull();
    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.com/ws/coding-agents/thread/thread_mobile?token=stream-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "thread.stream.attached", threadId: "thread_mobile" }) });
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "thread.event",
        event: {
          eventId: "evt_stream_mobile_1",
          threadId: "thread_mobile",
          type: "assistant.text.delta",
          messageId: "msg_mobile_1",
          delta: "Checking /home/matrix/secret and token_sk_live_123.",
          occurredAt: "2026-07-06T00:02:00.000Z",
        },
      }),
    });
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "thread.event",
        event: {
          eventId: "../unsafe",
          threadId: "thread_mobile",
          type: "assistant.text.delta",
          messageId: "msg_mobile_1",
          delta: "unsafe",
          occurredAt: "2026-07-06T00:02:00.000Z",
        },
      }),
    });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "thread.replay.end", nextCursor: "evt_stream_mobile_1" }) });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "evt_stream_mobile_1",
      threadId: "thread_mobile",
      type: "assistant.text.delta",
    });

    subscription?.detach();
    expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "detach" });
    expect(sockets[0]!.closed).toBe(true);

    fetchMock.mockRestore();
    global.WebSocket = OriginalWebSocket;
  });

  it("fetches installed apps from the gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([
        {
          name: "Notes",
          file: "notes/index.html",
          path: "/files/apps/notes/index.html",
        },
      ]));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getApps()).resolves.toEqual([
      {
        name: "Notes",
        file: "notes/index.html",
        path: "/files/apps/notes/index.html",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("fetches the coding agent runtime summary with the existing auth header", async () => {
    const summary = {
      runtime: {
        id: "rt_primary",
        label: "Primary",
        status: "available",
      },
      capabilities: [
        {
          id: "codingAgentsRuntimeSummary",
          enabled: true,
        },
      ],
      providers: [],
      projects: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      activeThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      attentionThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      terminalSessions: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      previewSessions: {
        items: [],
        limit: 50,
        hasMore: false,
      },
      recentActivity: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      limits: {
        maxPromptBytes: 16384,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 8192,
        maxListItems: 20,
      },
      serverTime: "2026-07-06T00:00:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(summary));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentRuntimeSummary()).resolves.toEqual({
      ok: true,
      summary,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/coding-agents/summary", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("creates scratch and imported projects through the canonical project route", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        project: {
          id: "mobile-scratch",
          label: "Mobile Scratch",
          status: "available",
          taskCount: 0,
          threadCount: 0,
          attentionCount: 0,
        },
        existing: false,
      }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        project: {
          id: "matrix-mobile",
          label: "matrix-mobile",
          status: "available",
          taskCount: 0,
          threadCount: 0,
          attentionCount: 0,
        },
        existing: true,
      }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createProject({
      mode: "scratch",
      name: "Mobile Scratch",
      clientRequestId: "req_mobile_project_scratch",
    })).resolves.toEqual({
      ok: true,
      project: expect.objectContaining({ id: "mobile-scratch" }),
      existing: false,
    });
    await expect(client.createProject({
      mode: "github",
      repositoryUrl: "https://github.com/acme/matrix-mobile",
      clientRequestId: "req_mobile_project_import",
    })).resolves.toEqual({
      ok: true,
      project: expect.objectContaining({ id: "matrix-mobile" }),
      existing: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/coding-agents/projects", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        mode: "scratch",
        name: "Mobile Scratch",
        clientRequestId: "req_mobile_project_scratch",
      }),
      signal: expect.any(Object),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/coding-agents/projects", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        mode: "github",
        repositoryUrl: "https://github.com/acme/matrix-mobile",
        clientRequestId: "req_mobile_project_import",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("fails closed when project creation does not return a valid canonical slug", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      project: { slug: "../../unsafe" },
    }, { status: 201 }));

    const client = new GatewayClient("http://localhost:4000", "token");

    await expect(client.createProject({
      mode: "scratch",
      name: "Mobile Scratch",
      clientRequestId: "req_mobile_project_invalid",
    })).resolves.toEqual({
      ok: false,
      error: "Project could not be created. Try again.",
    });

    fetchMock.mockRestore();
  });

  it("sends independent project workspace cursors", async () => {
    const pagedWorkspace = {
      project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 0, attentionCount: 0 },
      tasks: { items: [], hasMore: false, limit: 25 },
      projectThreads: { items: [], hasMore: false, limit: 30 },
      taskThreads: { items: [], hasMore: false, limit: 35 },
      updatedAt: "2026-07-10T13:30:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(pagedWorkspace));
    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentProjectWorkspace({
      projectId: "matrix-os",
      taskCursor: "task_auth",
      taskLimit: 25,
      projectThreadCursor: "thread_audit",
      projectThreadLimit: 30,
      taskThreadCursor: "thread_fix",
      taskThreadLimit: 35,
    })).resolves.toEqual({ ok: true, workspace: pagedWorkspace });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/projects/matrix-os/workspace?taskCursor=task_auth&taskLimit=25&projectThreadCursor=thread_audit&projectThreadLimit=30&taskThreadCursor=thread_fix&taskThreadLimit=35",
      expect.any(Object),
    );
    fetchMock.mockRestore();
  });

  it("fetches coding agent thread snapshots with the existing auth header", async () => {
    const snapshot = {
      thread: {
        id: "thread_mobile",
        providerId: "codex",
        title: "Repair mobile route",
        status: "running",
        attention: "none",
        terminalSessionId: "matrix-abc1234",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:01:00.000Z",
      },
      events: {
        items: [
          {
            eventId: "evt_mobile_1",
            threadId: "thread_mobile",
            type: "thread.status",
            status: "running",
            occurredAt: "2026-07-06T00:01:00.000Z",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentThreadSnapshot({ threadId: "thread_mobile" })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/coding-agents/threads/thread_mobile", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("fetches bounded project workspace pages with validated independent cursors", async () => {
    const pagedWorkspace = {
      project: {
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 0,
        threadCount: 0,
        attentionCount: 0,
      },
      tasks: { items: [], hasMore: false, limit: 25 },
      projectThreads: { items: [], hasMore: false, limit: 30 },
      taskThreads: { items: [], hasMore: false, limit: 35 },
      updatedAt: "2026-07-10T13:30:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(pagedWorkspace));
    const client = new GatewayClient("http://localhost:4000", "token");

    await expect(client.getCodingAgentProjectWorkspace({
      projectId: "matrix-os",
      taskCursor: "task_auth",
      taskLimit: 25,
      projectThreadCursor: "thread_audit",
      projectThreadLimit: 30,
      taskThreadCursor: "thread_fix",
      taskThreadLimit: 35,
    })).resolves.toEqual({ ok: true, workspace: pagedWorkspace });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/projects/matrix-os/workspace?taskCursor=task_auth&taskLimit=25&projectThreadCursor=thread_audit&projectThreadLimit=30&taskThreadCursor=thread_fix&taskThreadLimit=35",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("sends a validated turn to the selected coding agent thread", async () => {
    const request: CreateAgentTurnRequest = {
      message: "Continue with the mobile route tests.",
      clientRequestId: "req_mobile_turn_1",
    };
    const turn = {
      threadId: "thread_mobile",
      turnId: "turn_mobile_1",
      status: "accepted",
      acceptedAt: "2026-07-06T00:02:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(turn, { status: 202 }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createCodingAgentTurn({
      threadId: "thread_mobile",
      request,
    })).resolves.toEqual({ ok: true, turn });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/threads/thread_mobile/turns",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(request),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("rejects invalid turn requests locally and maps busy responses to a safe retry state", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      error: {
        code: "thread_busy",
        safeMessage: "This conversation cannot accept a message right now. Refresh and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    }, { status: 409 }));
    const client = new GatewayClient("http://localhost:4000", "token");

    await expect(client.createCodingAgentTurn({
      threadId: "not-a-thread",
      request: {
        message: "Continue.",
        clientRequestId: "req_mobile_turn_invalid",
      },
    })).resolves.toEqual({
      ok: false,
      error: "Message could not be sent. Refresh and try again.",
      reason: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.createCodingAgentTurn({
      threadId: "thread_mobile",
      request: {
        message: "Continue.",
        clientRequestId: "req_mobile_turn_busy",
      },
    })).resolves.toEqual({
      ok: false,
      error: "Conversation is busy. Refresh and try again.",
      reason: "busy",
    });

    fetchMock.mockRestore();
  });

  it("rejects malformed turn success payloads without exposing server details", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      threadId: "thread_other",
      turnId: "/home/matrix/turn-secret",
      status: "accepted",
      acceptedAt: "not-a-date",
    }, { status: 202 }));
    const client = new GatewayClient("http://localhost:4000", "token");

    await expect(client.createCodingAgentTurn({
      threadId: "thread_mobile",
      request: {
        message: "Continue.",
        clientRequestId: "req_mobile_turn_malformed",
      },
    })).resolves.toEqual({
      ok: false,
      error: "Message could not be sent. Refresh and try again.",
      reason: "unavailable",
    });

    fetchMock.mockRestore();
    warnSpy.mockRestore();
  });

  it("fetches and updates coding agent notification preferences with the existing auth header", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: false, completed: true } } }))
      .mockResolvedValueOnce(jsonResponse({ preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } } }));

    try {
      const client = new GatewayClient("http://localhost:4000", "token");
      await expect(client.getCodingAgentNotificationPreferences()).resolves.toEqual({
        ok: true,
        preferences: { attentionPush: { approval: true, input: true, failed: false, completed: true } },
      });
      await expect(client.updateCodingAgentNotificationPreferences({ attentionPush: { approval: true, input: true, failed: true, completed: true } })).resolves.toEqual({
        ok: true,
        preferences: { attentionPush: { approval: true, input: true, failed: true, completed: true } },
      });
      expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/coding-agents/notification-preferences", expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }));
      expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/coding-agents/notification-preferences", expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ attentionPush: { approval: true, input: true, failed: true, completed: true } }),
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("submits coding agent approval decisions with the existing auth header", async () => {
    const snapshot = {
      thread: {
        id: "thread_mobile",
        providerId: "codex",
        title: "Repair mobile route",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
      events: {
        items: [
          {
            eventId: "evt_mobile_approval_resolved",
            threadId: "thread_mobile",
            type: "approval.resolved",
            approvalId: "appr_mobile_1",
            decision: "approve",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.submitCodingAgentApprovalDecision({
      threadId: "thread_mobile",
      approvalId: "appr_mobile_1",
      decision: "approve",
      correlationId: "corr_mobile_1",
      clientRequestId: "req_mobile_approval_1",
    })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/threads/thread_mobile/approvals/appr_mobile_1/decision",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      decision: "approve",
      correlationId: "corr_mobile_1",
      clientRequestId: "req_mobile_approval_1",
    });

    fetchMock.mockRestore();
  });

  it("submits coding agent input answers with the existing auth header", async () => {
    const snapshot = {
      thread: {
        id: "thread_mobile",
        providerId: "codex",
        title: "Repair mobile route",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      events: {
        items: [
          {
            eventId: "evt_mobile_input_answered",
            threadId: "thread_mobile",
            type: "user_input.answered",
            requestId: "req_mobile_prompt_1",
            correlationId: "corr_input_mobile_1",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.submitCodingAgentInputAnswer({
      threadId: "thread_mobile",
      inputRequestId: "req_mobile_prompt_1",
      answer: "Run the focused mobile thread test.",
      correlationId: "corr_input_mobile_1",
      clientRequestId: "req_mobile_input_1",
    })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/threads/thread_mobile/inputs/req_mobile_prompt_1/answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      answer: "Run the focused mobile thread test.",
      correlationId: "corr_input_mobile_1",
      clientRequestId: "req_mobile_input_1",
    });

    fetchMock.mockRestore();
  });

  it("creates coding agent threads with the existing auth header", async () => {
    const snapshot = {
      thread: {
        id: "thread_mobile_create",
        providerId: "codex",
        title: "Investigate mobile composer",
        status: "queued",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      events: {
        items: [],
        hasMore: false,
        limit: 200,
      },
    };
    const request: CreateAgentThreadRequest = {
      providerId: "codex",
      prompt: "Investigate mobile composer",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      clientRequestId: "req_mobile_1",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createCodingAgentThread(request)).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/coding-agents/threads", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(request),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("fetches coding agent review summaries with the existing auth header", async () => {
    const reviews = {
      items: [
        {
          id: "rev_mobile_1",
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          status: "reviewing",
          pullRequestNumber: 757,
          round: 1,
          maxRounds: 3,
          reviewer: "codex",
          implementer: "claude",
          findings: {
            total: 2,
            high: 1,
            medium: 1,
            low: 0,
          },
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(reviews));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentReviews()).resolves.toEqual({
      ok: true,
      reviews,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/coding-agents/reviews", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    await expect(client.getCodingAgentReviews({ cursor: "rev_mobile_1" })).resolves.toEqual({
      ok: true,
      reviews,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/coding-agents/reviews?cursor=rev_mobile_1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("fetches coding agent review snapshots with the existing auth header", async () => {
    const snapshot = {
      review: {
        id: "rev_mobile_1",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        findings: {
          total: 1,
          high: 1,
          medium: 0,
          low: 0,
        },
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      files: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [],
            findings: [
              {
                id: "HIGH-1",
                severity: "high",
                line: 42,
                summary: "Validate ownership before returning snapshots.",
              },
            ],
          },
        ],
        hasMore: false,
        limit: 100,
      },
      partial: true,
      safeNotice: "Diff content is not available yet. Showing bounded review findings.",
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentReviewSnapshot({ reviewId: "rev_mobile_1" })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/coding-agents/reviews/rev_mobile_1", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("accepts contract-valid review references when fetching snapshots", async () => {
    const snapshot = {
      ...reviewSnapshotPayload(),
      review: {
        ...reviewSnapshotPayload().review,
        id: "rev_mobile:round.2",
      },
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(snapshot));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentReviewSnapshot({ reviewId: "rev_mobile:round.2" })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/reviews/rev_mobile%3Around.2",
      expect.any(Object),
    );

    fetchMock.mockRestore();
  });

  it("returns a safe mobile review details error for invalid gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      review: {
        id: "rev_mobile_1",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      files: {
        items: [
          {
            path: "/home/matrix/private/secret.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [],
          },
        ],
        hasMore: false,
        limit: 100,
      },
      partial: true,
      updatedAt: "2026-07-06T00:00:00.000Z",
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentReviewSnapshot({ reviewId: "rev_mobile_1" })).resolves.toEqual({
      ok: false,
      error: "Review details unavailable",
    });
    await expect(client.getCodingAgentReviewSnapshot({ reviewId: "../secret" })).resolves.toEqual({
      ok: false,
      error: "Review details unavailable",
    });

    fetchMock.mockRestore();
  });

  it("fetches coding agent file content with the existing auth header", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(fileReadPayload()));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    })).resolves.toEqual({
      ok: true,
      file: fileReadPayload(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/files/read?projectId=matrix-os&worktreeId=wt_abc123def456&path=packages%2Fgateway%2Fsrc%2Fcoding-agents%2Froutes.ts",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("fetches coding agent file browse entries with the existing auth header", async () => {
    const payload = fileBrowsePayload();
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(payload));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.browseCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      limit: 20,
    })).resolves.toEqual({
      ok: true,
      browse: payload,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/files/browse?projectId=matrix-os&worktreeId=wt_abc123def456&path=packages&limit=20",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("fetches coding agent file search results with the existing auth header", async () => {
    const payload = fileSearchPayload();
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(payload));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.searchCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      query: "routes",
      limit: 20,
    })).resolves.toEqual({
      ok: true,
      search: payload,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/files/search?projectId=matrix-os&worktreeId=wt_abc123def456&path=packages&query=routes&limit=20",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("browses primary project files without serializing an absent worktree", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(fileReadPayload()))
      .mockResolvedValueOnce(jsonResponse(fileBrowsePayload()))
      .mockResolvedValueOnce(jsonResponse(fileSearchPayload()));
    const client = new GatewayClient("http://localhost:4000", "token");

    await expect(client.getCodingAgentFileContent({
      projectId: "matrix-os",
      path: "README.md",
    })).resolves.toMatchObject({ ok: true });
    await expect(client.browseCodingAgentFiles({
      projectId: "matrix-os",
      limit: 20,
    })).resolves.toMatchObject({ ok: true });
    await expect(client.searchCodingAgentFiles({
      projectId: "matrix-os",
      query: "readme",
      limit: 20,
    })).resolves.toMatchObject({ ok: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:4000/api/coding-agents/files/read?projectId=matrix-os&path=README.md",
      "http://localhost:4000/api/coding-agents/files/browse?projectId=matrix-os&limit=20",
      "http://localhost:4000/api/coding-agents/files/search?projectId=matrix-os&query=readme&limit=20",
    ]);
    fetchMock.mockRestore();
  });

  it("returns safe mobile file browse and search errors for invalid inputs or payloads", async () => {
    const browseFetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...fileBrowsePayload(),
      entries: {
        ...fileBrowsePayload().entries,
        items: [{ path: "/home/matrix/private/secret.ts", kind: "file" }],
      },
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.browseCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
      limit: 20,
    })).resolves.toEqual({ ok: false, error: "File list unavailable" });
    await expect(client.browseCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      limit: 20,
    })).resolves.toEqual({ ok: false, error: "File list unavailable" });

    browseFetch.mockRestore();

    const searchFetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      matches: {
        items: [{ path: "/home/matrix/private/secret.ts", kind: "file" }],
        hasMore: false,
        limit: 20,
      },
    }));
    await expect(client.searchCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
      query: "routes",
      limit: 20,
    })).resolves.toEqual({ ok: false, error: "File search unavailable" });
    await expect(client.searchCodingAgentFiles({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: "routes",
      limit: 20,
    })).resolves.toEqual({ ok: false, error: "File search unavailable" });

    searchFetch.mockRestore();
  });

  it("returns a safe mobile file content error for invalid gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...fileReadPayload(),
      metadata: {
        ...fileReadPayload().metadata,
        path: "/home/matrix/private/secret.ts",
      },
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    })).resolves.toEqual({
      ok: false,
      error: "File content unavailable",
    });
    await expect(client.getCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
    })).resolves.toEqual({
      ok: false,
      error: "File content unavailable",
    });

    fetchMock.mockRestore();
  });

  it("saves coding agent file content with existing auth and safe validation", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(fileWritePayload()));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.saveCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_mobile_file",
      clientRequestId: "req_mobile_file_save",
    })).resolves.toEqual({
      ok: true,
      file: fileWritePayload(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/files/write",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          path: "packages/gateway/src/coding-agents/routes.ts",
          content: "export const safeRoute = false;\n",
          encoding: "utf8",
          baseEtag: "sha256_mobile_file",
          clientRequestId: "req_mobile_file_save",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("prepares coding agent source commits with existing auth and safe validation", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(sourceCommitPayload()));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.prepareCodingAgentSourceCommit({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_mobile_prepare_commit",
    })).resolves.toEqual({
      ok: true,
      commit: sourceCommitPayload(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/source-control/prepare-commit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          message: "fix: update reviewed files",
          paths: ["packages/gateway/src/coding-agents/routes.ts"],
          clientRequestId: "req_mobile_prepare_commit",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("creates coding agent source pull requests with existing auth and safe validation", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(sourcePullRequestPayload()));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createCodingAgentSourcePullRequest({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #759",
      body: "Review updates are ready.",
      clientRequestId: "req_mobile_create_pr",
    })).resolves.toEqual({
      ok: true,
      pullRequest: sourcePullRequestPayload(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/coding-agents/source-control/pull-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          title: "fix: apply review updates for PR #759",
          body: "Review updates are ready.",
          clientRequestId: "req_mobile_create_pr",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("returns a safe mobile file save error for invalid requests and gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...fileWritePayload(),
      metadata: {
        ...fileWritePayload().metadata,
        path: "/home/matrix/private/secret.ts",
      },
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.saveCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_mobile_file",
      clientRequestId: "req_mobile_file_save",
    })).resolves.toEqual({
      ok: false,
      error: "File could not be saved. Refresh and try again.",
    });
    await expect(client.saveCodingAgentFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "../system/config.json",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_mobile_file",
      clientRequestId: "req_mobile_file_save",
    })).resolves.toEqual({
      ok: false,
      error: "File could not be saved. Refresh and try again.",
    });

    fetchMock.mockRestore();
  });

  it("returns a safe mobile source-control error for invalid requests and gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...sourceCommitPayload(),
      branch: "/home/matrix/private",
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.prepareCodingAgentSourceCommit({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_mobile_prepare_commit",
    })).resolves.toEqual({
      ok: false,
      error: "Source commit could not be prepared. Refresh and try again.",
    });
    await expect(client.prepareCodingAgentSourceCommit({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["../system/config.json"],
      clientRequestId: "req_mobile_prepare_commit",
    })).resolves.toEqual({
      ok: false,
      error: "Source commit could not be prepared. Refresh and try again.",
    });

    fetchMock.mockRestore();
  });

  it("returns a safe mobile source-control pull request error for invalid requests and gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...sourcePullRequestPayload(),
      url: "file:///home/matrix/private/secret",
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createCodingAgentSourcePullRequest({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #759",
      body: "Review updates are ready.",
      clientRequestId: "req_mobile_create_pr",
    })).resolves.toEqual({
      ok: false,
      error: "Pull request could not be created. Refresh and try again.",
    });
    await expect(client.createCodingAgentSourcePullRequest({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "",
      body: "Review updates are ready.",
      clientRequestId: "req_mobile_create_pr",
    })).resolves.toEqual({
      ok: false,
      error: "Pull request could not be created. Refresh and try again.",
    });

    fetchMock.mockRestore();
  });

  it("returns a safe mobile thread create error for invalid gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      thread: {
        id: "../bad",
        providerId: "codex",
        title: "/home/matrix/private",
        status: "queued",
      },
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createCodingAgentThread({
      providerId: "codex",
      prompt: "Investigate mobile composer",
      clientRequestId: "req_mobile_1",
    })).resolves.toEqual({
      ok: false,
      error: "Agent run could not be started. Try again.",
    });

    fetchMock.mockRestore();
  });

  it("returns safe mobile action errors for invalid approval and input payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "/home/matrix/secret" }))
      .mockResolvedValueOnce(jsonResponse({ token: "sk_live_secret" }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.submitCodingAgentApprovalDecision({
      threadId: "thread_mobile",
      approvalId: "appr_mobile_1",
      decision: "approve",
      correlationId: "corr_mobile_1",
      clientRequestId: "req_mobile_approval_1",
    })).resolves.toEqual({
      ok: false,
      error: "Approval could not be sent. Try again.",
    });
    await expect(client.submitCodingAgentInputAnswer({
      threadId: "thread_mobile",
      inputRequestId: "req_mobile_prompt_1",
      answer: "Proceed.",
      correlationId: "corr_mobile_1",
      clientRequestId: "req_mobile_input_1",
    })).resolves.toEqual({
      ok: false,
      error: "Input could not be sent. Try again.",
    });

    fetchMock.mockRestore();
  });

  it("returns a safe mobile review error for invalid gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      items: [
        {
          id: "../bad",
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          status: "reviewing",
          safeStatus: "Postgres failed at /home/matrix/home",
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentReviews()).resolves.toEqual({
      ok: false,
      error: "Review state unavailable",
    });

    fetchMock.mockRestore();
  });

  it("returns a safe mobile summary error for invalid gateway payloads", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      runtime: { id: "../bad", label: "/home/matrix/secret", status: "broken" },
    }));

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getCodingAgentRuntimeSummary()).resolves.toEqual({
      ok: false,
      error: "Runtime summary unavailable",
    });

    fetchMock.mockRestore();
  });

  it("refreshes Clerk bearer tokens for each gateway HTTP request", async () => {
    const getToken = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce([]),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          manifest: { name: "Notes" },
          runtimeState: { status: "ready" },
        }),
      } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000", getToken);
    await expect(client.getApps()).resolves.toEqual([]);
    await expect(client.getAppManifest("notes")).resolves.toEqual({
      manifest: { name: "Notes" },
      runtimeState: { status: "ready" },
    });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/apps", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/apps/notes/manifest", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
    }));

    fetchMock.mockRestore();
  });

  it("refreshes Clerk bearer tokens before building WebView headers", async () => {
    const getToken = jest.fn<Promise<string | null>, []>().mockResolvedValueOnce("fresh-token");

    const client = new GatewayClient("http://localhost:4000", getToken);
    await expect(client.webViewHeaders()).resolves.toEqual({
      Authorization: "Bearer fresh-token",
    });

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("fetches per-app manifest details from the gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
        manifest: { name: "Notes" },
        runtimeState: { status: "ready" },
      }));

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getAppManifest("notes")).resolves.toEqual({
      manifest: { name: "Notes" },
      runtimeState: { status: "ready" },
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps/notes/manifest", expect.objectContaining({
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("preserves path separators when fetching nested app manifests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        manifest: { name: "Chess" },
        runtimeState: { status: "ready" },
      }),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getAppManifest("games/chess")).resolves.toEqual({
      manifest: { name: "Chess" },
      runtimeState: { status: "ready" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/apps/games/chess/manifest",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
        signal: expect.any(Object),
      }),
    );

    fetchMock.mockRestore();
  });

  it("preserves path separators when creating nested app session tokens", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        launchUrl: "/apps/chess/?session=token",
        expiresAt: 1_779_000_000_000,
      }),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createAppSessionToken("games/chess")).resolves.toEqual({
      launchUrl: "/apps/chess/?session=token",
      expiresAt: 1_779_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/apps/games/chess/session-token",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );

    fetchMock.mockRestore();
  });

  it("fetches a platform websocket token using bearer auth", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ token: "ws-token" }));

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    await expect(client.getWsToken()).resolves.toBe("ws-token");
    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/auth/ws-token", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer clerk-token",
        "Content-Type": "application/json",
      }),
      signal: expect.any(Object),
    }));

    fetchMock.mockRestore();
  });

  it("refreshes expired websocket tokens before reconnecting", async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const OriginalWebSocket = global.WebSocket;
    const sockets: Array<{
      readyState: number;
      close: jest.Mock;
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: ((event: { code: number; reason: string }) => void) | null;
    }> = [];
    const webSocketMock = jest.fn().mockImplementation(() => {
      const socket = {
        readyState: 0,
        close: jest.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      sockets.push(socket);
      return socket;
    });
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        token: "fresh-ws-token",
        expiresAt: Date.now() + 300_000,
      }),
    } as unknown as Response);

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    client.setWebSocketToken("expired-ws-token", Date.now() - 1000);
    client.connect();
    sockets[0]?.onclose?.({ code: 1006, reason: "/home/matrix/home token=ghp_privatevalue1234567890" });

    await jest.runOnlyPendingTimersAsync();

    expect(warnSpy).toHaveBeenCalledWith(
      "[mobile] websocket closed",
      expect.objectContaining({
        name: "Unknown",
        message: expect.stringContaining("[path]"),
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/\/home\/matrix|ghp_privatevalue/i);

    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/auth/ws-token", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
    }));
    expect(webSocketMock).toHaveBeenLastCalledWith(
      "wss://app.matrix-os.com/ws?token=fresh-ws-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    fetchMock.mockRestore();
    warnSpy.mockRestore();
    global.WebSocket = OriginalWebSocket;
    jest.useRealTimers();
  });

  it("adds timeout signals to gateway HTTP requests", async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockReturnValue("timeout-signal" as unknown as AbortSignal);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([]));

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getApps()).resolves.toEqual([]);

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_GATEWAY_FETCH_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps", expect.objectContaining({
      signal: "timeout-signal",
    }));

    fetchMock.mockRestore();
    timeoutSpy.mockRestore();
  });

  it("returns a safe fallback when app inventory fetch fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(global, "fetch").mockRejectedValueOnce(
      new Error("network unavailable /var/run/provider.sock token=sk_live_private"),
    );

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getApps()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mobile] /api/apps unavailable",
      expect.objectContaining({
        name: "Error",
        message: expect.stringContaining("[path]"),
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/\/var\/run|sk_live_private/i);

    fetchMock.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not log raw app inventory error bodies", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: jest.fn().mockResolvedValueOnce("raw /home/matrix/home token=ghp_privatevalue1234567890"),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getApps()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mobile] /api/apps unavailable",
      expect.objectContaining({
        name: "Unknown",
        message: "status 503",
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/\/home\/matrix|ghp_privatevalue|raw/i);

    fetchMock.mockRestore();
    warnSpy.mockRestore();
  });

  it("returns a generic health error instead of raw network failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(global, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED /var/run/provider.sock"),
    );

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      error: "Gateway unavailable",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[mobile] gateway health check unavailable",
      expect.objectContaining({
        name: "Unknown",
        message: "unavailable",
      }),
    );

    fetchMock.mockRestore();
    warnSpy.mockRestore();
  });
});
