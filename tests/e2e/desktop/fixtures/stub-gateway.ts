// Minimal gateway stub implementing the contract subset the Operator desktop
// app consumes (specs/094-electron-macos-shell/contracts/gateway-contract.md).
// Device auth approves instantly; one project with tasks; one fake zellij echo
// session with sequence-numbered output; scripted kernel stream.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export interface StubGateway {
  url: string;
  port: number;
  close(): Promise<void>;
  state: {
    deviceCodeRequests: number;
    tokenRequests: number;
    terminalInputs: string[];
    kernelMessages: Array<Record<string, unknown>>;
  };
}

const TOKEN = "stub-token-1";

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
  } catch {
    return {};
  }
}

const TASKS = [
  {
    id: "task-1",
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
    id: "task-2",
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

export async function startStubGateway(): Promise<StubGateway> {
  const state: StubGateway["state"] = {
    deviceCodeRequests: 0,
    tokenRequests: 0,
    terminalInputs: [],
    kernelMessages: [],
  };

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
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: "unauthorized" });
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

    if (path === "/api/workspace/projects") {
      json(res, 200, { projects: [{ slug: "matrix-os", name: "Matrix OS" }] });
      return;
    }
    if (path === "/api/projects/matrix-os/tasks" && req.method === "GET") {
      json(res, 200, { tasks: TASKS, nextCursor: null });
      return;
    }
    if (path.startsWith("/api/projects/matrix-os/tasks/") && req.method === "PATCH") {
      const id = path.split("/").pop();
      const body = await readBody(req);
      const task = TASKS.find((t) => t.id === id);
      json(res, 200, { task: { ...(task ?? TASKS[0]), ...body } });
      return;
    }
    if (path === "/api/projects/matrix-os/tasks" && req.method === "POST") {
      const body = await readBody(req);
      json(res, 201, {
        task: {
          ...TASKS[0],
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
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
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

  let seq = 0;
  function runTerminalSession(ws: WebSocket, session: string): void {
    if (session !== "matrix-task-1") {
      ws.send(JSON.stringify({ type: "error", code: "session_not_found", message: "Session not found" }));
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: "attached", session, state: "running", fromSeq: seq }));
    seq += 1;
    ws.send(JSON.stringify({ type: "output", seq, data: "stub-shell$ " }));
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        state.terminalInputs.push(msg.data);
        seq += 1;
        // Echo back like a shell, with deterministic seq numbering.
        ws.send(JSON.stringify({ type: "output", seq, data: msg.data.replace(/\r/g, "\r\nran!\r\nstub-shell$ ") }));
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
      } catch {
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
        ws.send(JSON.stringify({ type: "kernel:tool_end", input: "ls", requestId }));
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        terminalWss.close();
        kernelWss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
