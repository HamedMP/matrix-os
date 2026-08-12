// Minimal gateway stub implementing the contract subset the Operator desktop
// app consumes (specs/094-electron-macos-shell/contracts/gateway-contract.md).
// Device auth approves instantly; one project with tasks; one fake zellij echo
// session with sequence-numbered output; scripted kernel stream.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentThreadSnapshotSchema,
  ProjectAgentWorkspaceSchema,
  RuntimeSummarySchema,
  type AgentThreadSnapshot,
  type ProjectAgentWorkspace,
  type RuntimeSummary,
} from "@matrix-os/contracts";

export interface StubGateway {
  url: string;
  port: number;
  sendTerminalOutput(data: string): void;
  close(): Promise<void>;
  state: {
    deviceCodeRequests: number;
    tokenRequests: number;
    terminalInputs: string[];
    kernelMessages: Array<Record<string, unknown>>;
    codingAgentCreates: Array<Record<string, unknown>>;
    taskUpdates: Array<Record<string, unknown>>;
    runtimeSelections: string[];
  };
}

const TOKEN = "stub-token-1";
const REVIEW_TOKEN = "stub-review-token-with-enough-entropy-1";
const NOW = "2026-07-08T00:00:00.000Z";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    console.warn("[stub-gateway] failed to parse request body:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

const TASKS = [
  {
    id: "task_auth",
    projectSlug: "matrix-os",
    title: "Fix the failing auth tests",
    description: "",
    status: "todo",
    priority: "high",
    order: 1,
    parentTaskId: null,
    linkedSessionId: "sess-orch-1",
    linkedWorktreeId: null,
    previewIds: [],
    tags: ["auth"],
    updatedAt: new Date(0).toISOString(),
    revision: 1,
  },
  {
    id: "task_polish",
    projectSlug: "matrix-os",
    title: "Polish the board design",
    description: "",
    status: "running",
    priority: "normal",
    order: 1,
    parentTaskId: null,
    linkedSessionId: null,
    linkedWorktreeId: null,
    previewIds: [],
    tags: [],
    updatedAt: new Date(0).toISOString(),
    revision: 1,
  },
];

function codingAgentThread(prompt = "Fix the failing auth tests"): AgentThreadSnapshot["thread"] {
  return {
    id: "thread_operator_1",
    providerId: "codex",
    title: prompt.slice(0, 120),
    status: "completed",
    attention: "completed",
    projectId: "matrix-os",
    terminalSessionId: "matrix-task-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function codingAgentTaskThread(
  id: string,
  taskId: string,
  title: string,
  status: AgentThreadSnapshot["thread"]["status"],
): AgentThreadSnapshot["thread"] {
  return {
    id,
    providerId: "codex",
    title,
    status,
    attention: status === "completed" ? "completed" : "none",
    projectId: "matrix-os",
    taskId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function codingAgentProjectWorkspace(tasks = TASKS): ProjectAgentWorkspace {
  const authTask = tasks.find((task) => task.id === "task_auth") ?? TASKS[0];
  const polishTask = tasks.find((task) => task.id === "task_polish") ?? TASKS[1];
  return ProjectAgentWorkspaceSchema.parse({
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 2,
      threadCount: 3,
      attentionCount: 0,
      updatedAt: NOW,
    },
    tasks: {
      items: [
        {
          id: "task_auth",
          projectId: "matrix-os",
          title: "Fix the failing auth tests",
          status: authTask.status,
          priority: "high",
          order: 0,
          threadCount: 2,
          activeThreadCount: 1,
          attentionCount: 0,
          latestThreadAt: NOW,
          revision: authTask.revision,
        },
        {
          id: "task_polish",
          projectId: "matrix-os",
          title: "Polish the board design",
          status: polishTask.status,
          priority: "normal",
          order: 1,
          threadCount: 0,
          activeThreadCount: 0,
          attentionCount: 0,
          revision: polishTask.revision,
        },
      ],
      hasMore: false,
      limit: 50,
    },
    projectThreads: {
      items: [codingAgentThread()],
      hasMore: false,
      limit: 50,
    },
    taskThreads: {
      items: [
        codingAgentTaskThread(
          "thread_task_auth_1",
          "task_auth",
          "Investigate auth callback",
          "running",
        ),
        codingAgentTaskThread(
          "thread_task_auth_2",
          "task_auth",
          "Verify token refresh",
          "completed",
        ),
      ],
      hasMore: false,
      limit: 50,
    },
    updatedAt: NOW,
  });
}

export function codingAgentSnapshot(prompt = "Fix the failing auth tests"): AgentThreadSnapshot {
  const thread = codingAgentThread(prompt);
  return AgentThreadSnapshotSchema.parse({
    thread,
    events: {
      items: [
        {
          type: "thread.created",
          eventId: "evt_operator_created",
          threadId: thread.id,
          occurredAt: NOW,
          thread,
        },
        {
          type: "user.message",
          eventId: "evt_operator_user_message",
          threadId: thread.id,
          occurredAt: NOW,
          messageId: "msg_operator_user_1",
          text: prompt,
          clientRequestId: "req_operator_user_1",
        },
        {
          type: "assistant.text.delta",
          eventId: "evt_operator_text",
          threadId: thread.id,
          occurredAt: NOW,
          messageId: "msg_operator_1",
          delta: "Done - all tests pass.",
        },
        {
          type: "assistant.text.completed",
          eventId: "evt_operator_text_done",
          threadId: thread.id,
          occurredAt: NOW,
          messageId: "msg_operator_1",
        },
        {
          type: "terminal.bound",
          eventId: "evt_operator_terminal",
          threadId: thread.id,
          occurredAt: NOW,
          terminalSessionId: "matrix-task-1",
        },
        {
          type: "thread.completed",
          eventId: "evt_operator_completed",
          threadId: thread.id,
          occurredAt: NOW,
          outcome: "completed",
        },
      ],
      hasMore: false,
      limit: 200,
    },
  });
}

function codingAgentTaskSnapshot(
  id: string,
  taskId: string,
  title: string,
  status: AgentThreadSnapshot["thread"]["status"],
): AgentThreadSnapshot {
  const thread = codingAgentTaskThread(id, taskId, title, status);
  return AgentThreadSnapshotSchema.parse({
    thread,
    events: {
      items: [
        {
          type: "thread.created",
          eventId: `evt_${id}_created`,
          threadId: id,
          occurredAt: NOW,
          thread,
        },
        ...(id === "thread_task_auth_1" ? [
          {
            type: "user.message",
            eventId: "evt_task_auth_user",
            threadId: id,
            occurredAt: NOW,
            messageId: "msg_task_auth_user",
            clientRequestId: "req_task_auth_user",
            text: "Trace why the OAuth callback drops the return path.",
            attachments: [{
              id: "att_auth_callback",
              kind: "file",
              label: "auth-callback.ts",
              path: "packages/platform/src/auth-callback.ts",
              mimeType: "text/typescript",
              sizeBytes: 4_812,
            }],
          },
          {
            type: "assistant.text.delta",
            eventId: "evt_task_auth_assistant",
            threadId: id,
            occurredAt: NOW,
            messageId: "msg_task_auth_assistant",
            delta: "I found the return path being discarded during callback validation. I’ll preserve the verified destination and add a regression test.",
          },
          {
            type: "assistant.text.completed",
            eventId: "evt_task_auth_assistant_done",
            threadId: id,
            occurredAt: NOW,
            messageId: "msg_task_auth_assistant",
          },
          {
            type: "tool.started",
            eventId: "evt_task_auth_tool",
            threadId: id,
            occurredAt: NOW,
            toolCallId: "tool_task_auth_read",
            displayName: "Read auth callback",
            kind: "read",
          },
          {
            type: "tool.completed",
            eventId: "evt_task_auth_tool_done",
            threadId: id,
            occurredAt: NOW,
            toolCallId: "tool_task_auth_read",
            outcome: "success",
          },
        ] : []),
      ],
      hasMore: false,
      limit: 200,
    },
  });
}

export function codingAgentSummary(): RuntimeSummary {
  return RuntimeSummarySchema.parse({
    runtime: {
      id: "rt_operator",
      label: "Operator stub",
      status: "available",
      channel: "dev",
      ownerHandle: "neo",
    },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsDesktopWorkspace", enabled: true },
      { id: "codingAgentsProjectWorkspace", enabled: true },
      { id: "codingAgentsConversationView", enabled: true },
      { id: "codingAgentsKanbanView", enabled: true },
      { id: "codingAgentsSameThreadTurns", enabled: true },
      { id: "codingAgentsThreadCreate", enabled: true },
      { id: "codingAgentsReview", enabled: true },
      { id: "codingAgentsFiles", enabled: true },
      { id: "codingAgentsSourceControl", enabled: true },
      { id: "codingAgentsPreview", enabled: true },
      { id: "codingAgentsNativeMobileTerminal", enabled: true },
    ],
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        kind: "codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "plan"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: NOW,
      },
      {
        id: "pi",
        displayName: "Pi",
        kind: "pi",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: NOW,
      },
    ],
    projects: {
      items: [{
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 2,
        threadCount: 3,
        attentionCount: 0,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 50,
    },
    activeThreads: {
      items: [codingAgentThread()],
      hasMore: false,
      limit: 50,
    },
    attentionThreads: {
      items: [],
      hasMore: false,
      limit: 50,
    },
    terminalSessions: {
      items: [
        {
          id: "matrix-task-1",
          name: "Matrix shell",
          status: "running",
          attachable: true,
          cwdLabel: "matrix-os",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      hasMore: false,
      limit: 50,
    },
    previewSessions: {
      items: [{
        id: "preview-operator-1",
        label: "Matrix OS web",
        status: "running",
        origin: "https://preview.matrix-os.test",
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 50,
    },
    recentActivity: {
      items: [],
      hasMore: false,
      limit: 100,
    },
    limits: {
      maxPromptBytes: 96 * 1024,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 64 * 1024,
      maxListItems: 50,
    },
    serverTime: NOW,
  });
}

export async function startStubGateway(): Promise<StubGateway> {
  const tasks = TASKS.map((task) => ({ ...task, tags: [...task.tags] }));
  let projectLifecycle: "active" | "archived" | "deleted" = "active";
  const state: StubGateway["state"] = {
    deviceCodeRequests: 0,
    tokenRequests: 0,
    terminalInputs: [],
    kernelMessages: [],
    codingAgentCreates: [],
    taskUpdates: [],
    runtimeSelections: [],
  };
  let currentToken = TOKEN;
  let activeTerminalOutput: ((data: string) => void) | null = null;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/auth/device/code") {
      state.deviceCodeRequests += 1;
      await readBody(req);
      json(res, 200, {
        deviceCode: "stub-device-code",
        userCode: "STUB-1234",
        verificationUri: "https://example.test/activate",
        expiresIn: 600,
        interval: 1,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/auth/device/token") {
      state.tokenRequests += 1;
      await readBody(req);
      json(res, 200, {
        accessToken: TOKEN,
        expiresAt: Date.now() + 3_600_000,
        userId: "user-1",
        handle: "neo",
        displayName: "Thomas Anderson",
      });
      return;
    }

    if (req.method === "GET" && path === "/") {
      html(
        res,
        200,
        `<!doctype html>
          <html>
            <body style="margin:0;background:#083344;color:#ecfeff;font:600 20px system-ui;display:grid;place-items:center;min-height:100vh">
              <main style="text-align:center">
                <div>Stub Hosted Shell</div>
                <small style="display:block;margin-top:8px;font-size:13px;color:#a5f3fc">Canvas preview</small>
              </main>
            </body>
          </html>`,
      );
      return;
    }

    // Everything below requires the bearer header (verifies header injection).
    if (req.headers.authorization !== `Bearer ${currentToken}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && path === "/api/auth/computers") {
      json(res, 200, {
        items: [
          {
            handle: "neo",
            runtimeSlot: "primary",
            label: "Main Computer",
            availability: "available",
            kind: "customer",
            gatewayPath: "/vm/neo",
            capabilities: [],
          },
          {
            handle: "neo-review",
            runtimeSlot: "review",
            label: "Additional Computer",
            availability: "available",
            kind: "preview",
            gatewayPath: "/vm/neo-review?runtime=review",
            capabilities: [],
          },
        ],
        selectedSlot: currentToken === REVIEW_TOKEN ? "review" : "primary",
        hasMore: false,
        limit: 20,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/auth/runtime-selection") {
      const body = await readBody(req);
      if (body.slot !== "review") {
        json(res, 404, { error: "Computer unavailable" });
        return;
      }
      state.runtimeSelections.push("review");
      currentToken = REVIEW_TOKEN;
      json(res, 200, {
        accessToken: REVIEW_TOKEN,
        expiresAt: Date.now() + 3_600_000,
        handle: "neo-review",
        slot: "review",
      });
      return;
    }

    if (req.method === "POST" && path === "/api/auth/app-session") {
      await readBody(req);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          "matrix_app_session=stub-app-session; Path=/; HttpOnly; SameSite=Lax",
          "matrix_native_app_session=stub-native-session; Path=/; HttpOnly; SameSite=Lax",
        ],
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && path === "/api/workspace/projects") {
      const visibility = url.searchParams.get("visibility") ?? "active";
      const visible = projectLifecycle !== "deleted" && (
        visibility === "all" ||
        (visibility === "active" && projectLifecycle === "active") ||
        (visibility === "archived" && projectLifecycle === "archived")
      );
      json(res, 200, {
        projects: visible ? [{
          slug: "matrix-os",
          name: "Matrix OS",
          kind: "github",
          ...(projectLifecycle === "archived" ? { archivedAt: NOW } : {}),
        }] : [],
      });
      return;
    }
    if (req.method === "POST" && path === "/api/projects/matrix-os/actions") {
      const body = await readBody(req);
      if (body.type === "archive") projectLifecycle = "archived";
      else if (body.type === "restore") projectLifecycle = "active";
      else if (body.type === "delete" && body.confirmation === "Matrix OS") projectLifecycle = "deleted";
      else {
        json(res, 400, { error: "Project action is invalid", code: "invalid_request" });
        return;
      }
      json(res, 200, { ok: true, action: body.type, projectSlug: "matrix-os" });
      return;
    }
    if (req.method === "GET" && path === "/api/settings/skills") {
      json(res, 200, [
        { name: "code-review", file: ".agents/skills/code-review/SKILL.md", enabled: true },
        { name: "ship-stack", file: ".agents/skills/ship-stack/SKILL.md", enabled: true },
        { name: "design-critique", file: ".agents/skills/design-critique/SKILL.md", enabled: true },
      ]);
      return;
    }
    if (req.method === "GET" && path === "/api/files/list") {
      const folder = url.searchParams.get("path") ?? "";
      const entries = folder === "workspaces"
        ? [
            { name: "matrix-os", type: "directory", children: 18, modified: NOW },
            { name: "t3code", type: "directory", children: 12, modified: "2026-07-30T17:00:00.000Z" },
            { name: "README.md", type: "file", size: 4_862, modified: NOW },
          ]
        : [
            { name: "workspaces", type: "directory", children: 3, modified: NOW },
            { name: "apps", type: "directory", children: 7, modified: "2026-07-31T16:00:00.000Z" },
            { name: "system", type: "directory", children: 9, modified: "2026-07-29T12:00:00.000Z" },
            { name: "SOUL.md", type: "file", size: 2_741, modified: NOW },
          ];
      json(res, 200, { entries });
      return;
    }
    if (path === "/api/projects/matrix-os/tasks" && req.method === "GET") {
      json(res, 200, { tasks, nextCursor: null });
      return;
    }
    if (path === "/api/projects/matrix-os/commits" && req.method === "GET") {
      const shellSha = "a".repeat(40);
      const historySha = "b".repeat(40);
      const baseSha = "c".repeat(40);
      json(res, 200, {
        commits: [
          {
            sha: shellSha,
            parents: [historySha],
            author: "Hamed",
            timestamp: NOW,
            subject: "feat(desktop): add project-centric shell",
            refs: ["main"],
            tags: [],
            head: true,
          },
          {
            sha: historySha,
            parents: [baseSha],
            author: "Matrix",
            timestamp: "2026-07-07T23:45:00.000Z",
            subject: "fix(gateway): bound commit history",
            refs: ["origin/main"],
            tags: ["desktop-v1"],
            head: false,
          },
          {
            sha: baseSha,
            parents: [],
            author: "Matrix",
            timestamp: "2026-07-07T23:30:00.000Z",
            subject: "chore: initialize remote workspace",
            refs: [],
            tags: [],
            head: false,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    if (path.startsWith("/api/projects/matrix-os/tasks/") && req.method === "PATCH") {
      const id = path.split("/").pop();
      const body = await readBody(req);
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) {
        json(res, 404, { error: "not found" });
        return;
      }
      const status = typeof body.status === "string" ? body.status : task.status;
      const order = typeof body.order === "number" ? body.order : task.order;
      Object.assign(task, { status, order, revision: task.revision + 1 });
      state.taskUpdates.push({ taskId: task.id, ...body });
      json(res, 200, { task });
      return;
    }
    if (path === "/api/projects/matrix-os/tasks" && req.method === "POST") {
      const body = await readBody(req);
      json(res, 201, {
        task: {
          ...tasks[0],
          id: `task-${Date.now()}`,
          title: typeof body.title === "string" ? body.title : "New task",
          status: typeof body.status === "string" ? body.status : "todo",
          linkedSessionId: null,
          tags: [],
        },
      });
      return;
    }
    if (path === "/api/terminal/sessions") {
      json(res, 200, { sessions: [{ name: "matrix-task-1", status: "active" }] });
      return;
    }
    if (req.method === "GET" && path === "/api/auth/ws-token") {
      json(res, 200, {
        token: "stub-ws-token",
        expiresAt: Date.now() + 60_000,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/summary") {
      json(res, 200, codingAgentSummary());
      return;
    }
    if (
      req.method === "GET"
      && path === "/api/coding-agents/projects/matrix-os/workspace"
    ) {
      json(res, 200, codingAgentProjectWorkspace(tasks));
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/notification-preferences") {
      json(res, 200, {
        preferences: {
          attentionPush: {
            approval: true,
            input: true,
            failed: true,
            completed: true,
          },
        },
      });
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/reviews") {
      json(res, 200, {
        items: [{
          id: "rev_operator_1",
          projectId: "matrix-os",
          worktreeId: "wt_abcdef123456",
          status: "reviewing",
          pullRequestNumber: 917,
          round: 2,
          maxRounds: 3,
          reviewer: "matrix-reviewer",
          implementer: "matrix-implementer",
          findings: { total: 2, high: 0, medium: 1, low: 1 },
          updatedAt: NOW,
        }],
        hasMore: false,
        limit: 50,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/reviews/rev_operator_1") {
      json(res, 200, {
        review: {
          id: "rev_operator_1",
          projectId: "matrix-os",
          worktreeId: "wt_abcdef123456",
          status: "reviewing",
          pullRequestNumber: 917,
          round: 2,
          maxRounds: 3,
          reviewer: "matrix-reviewer",
          implementer: "matrix-implementer",
          findings: { total: 2, high: 0, medium: 1, low: 1 },
          updatedAt: NOW,
        },
        files: {
          items: [{
            path: "desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx",
            status: "modified",
            additions: 48,
            deletions: 22,
            partial: false,
            hunks: [{
              id: "hunk_operator_1",
              oldStart: 1548,
              oldLines: 3,
              newStart: 1548,
              newLines: 5,
              heading: "Contextual inspector",
              partial: false,
              lines: [
                { kind: "context", oldLine: 1548, newLine: 1548, content: "<aside aria-label=\"Conversation tools\">" },
                { kind: "remove", oldLine: 1549, content: "<AgentWorkspaceStack>" },
                { kind: "add", newLine: 1549, content: "<AgentConversationInspector" },
              ],
            }],
            findings: [{
              id: "MEDIUM-1",
              severity: "medium",
              line: 1549,
              summary: "Keep contextual tools keyboard accessible.",
            }],
          }],
          hasMore: false,
          limit: 100,
        },
        partial: false,
        updatedAt: NOW,
      });
      return;
    }
    if (req.method === "POST" && path === "/api/coding-agents/threads") {
      const body = await readBody(req);
      state.codingAgentCreates.push(body);
      json(res, 201, codingAgentSnapshot(typeof body.prompt === "string" ? body.prompt : undefined));
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/threads/thread_operator_1") {
      json(res, 200, codingAgentSnapshot());
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/threads/thread_task_auth_1") {
      json(res, 200, codingAgentTaskSnapshot(
        "thread_task_auth_1",
        "task_auth",
        "Investigate auth callback",
        "running",
      ));
      return;
    }
    if (req.method === "GET" && path === "/api/coding-agents/threads/thread_task_auth_2") {
      json(res, 200, codingAgentTaskSnapshot(
        "thread_task_auth_2",
        "task_auth",
        "Verify token refresh",
        "completed",
      ));
      return;
    }
    if (req.method === "GET" && path === "/api/integrations/available") {
      json(res, 200, [
        { id: "gmail", name: "Gmail", category: "Google Workspace" },
        { id: "github", name: "GitHub", category: "Developer tools" },
        { id: "slack", name: "Slack", category: "Communication" },
      ]);
      return;
    }
    if (req.method === "GET" && path === "/api/integrations") {
      json(res, 200, [{
        id: "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f",
        service: "gmail",
        account_label: "Matrix OS Team",
        account_email: "team@matrix-os.com",
        status: "active",
        connected_at: "2026-07-08T00:00:00.000Z",
      }]);
      return;
    }
    if (path === "/api/sessions") {
      json(res, 200, {
        sessions: [
          { id: "sess-orch-1", name: "Task 1 session", runtime: { zellijSession: "matrix-task-1" } },
          { id: "sess-orch-2", name: "Orchestrator-only", runtime: {} },
        ],
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/apps") {
      json(res, 200, {
        apps: [
          { slug: "notes", name: "Notes", category: "productivity" },
          { slug: "pomodoro", name: "Pomodoro", category: "productivity" },
        ],
      });
      return;
    }
    if (path === "/api/system/info") {
      json(res, 200, {
        version: "stub",
        uptime: 1,
        runtime: { handle: "neo", runtimeSlot: "primary" },
        resources: { cpuCount: 8, memoryTotal: 8e9, memoryFree: 4e9, diskTotal: 1e11, diskFree: 5e10 },
      });
      return;
    }
    json(res, 404, { error: "not found" });
  }

  const terminalWss = new WebSocketServer({ noServer: true });
  const kernelWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // WS upgrades carry the bearer header via the app's header injection.
    if (req.headers.authorization !== `Bearer ${currentToken}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/terminal/session") {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        runTerminalSession(ws, url.searchParams.get("session") ?? "");
      });
      return;
    }
    if (url.pathname === "/ws") {
      kernelWss.handleUpgrade(req, socket, head, (ws) => {
        runKernel(ws);
      });
      return;
    }
    socket.destroy();
  });

  function runTerminalSession(ws: WebSocket, session: string): void {
    let seq = 0;
    if (session !== "matrix-task-1") {
      ws.send(JSON.stringify({ type: "error", code: "session_not_found", message: "Session not found" }));
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: "attached", session, state: "running", fromSeq: seq }));
    const sendOutput = (data: string) => {
      seq += 1;
      ws.send(JSON.stringify({ type: "output", seq, data }));
    };
    activeTerminalOutput = sendOutput;
    ws.once("close", () => {
      if (activeTerminalOutput === sendOutput) activeTerminalOutput = null;
    });
    sendOutput("stub-shell$ ");
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch (err: unknown) {
        console.warn(
          "[stub-gateway] failed to parse terminal websocket frame:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        state.terminalInputs.push(msg.data);
        // Echo back like a shell, with deterministic seq numbering.
        sendOutput(msg.data.replace(/\r/g, "\r\nran!\r\nstub-shell$ "));
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
  }

  function runKernel(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch (err: unknown) {
        console.warn(
          "[stub-gateway] failed to parse kernel websocket frame:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      state.kernelMessages.push(msg);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "message") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "r1";
        ws.send(JSON.stringify({ type: "kernel:init", sessionId: "kernel-sess-1", requestId }));
        ws.send(JSON.stringify({ type: "kernel:text", text: "On it. ", requestId }));
        ws.send(JSON.stringify({ type: "kernel:tool_start", tool: "Bash", requestId }));
        ws.send(JSON.stringify({ type: "kernel:tool_end", input: { command: "ls" }, requestId }));
        ws.send(JSON.stringify({ type: "kernel:text", text: "Done — all tests pass.", requestId }));
        ws.send(JSON.stringify({ type: "kernel:result", data: "ok", requestId }));
      }
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    sendTerminalOutput: (data) => activeTerminalOutput?.(data),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of terminalWss.clients) client.terminate();
        for (const client of kernelWss.clients) client.terminate();
        terminalWss.close();
        kernelWss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
