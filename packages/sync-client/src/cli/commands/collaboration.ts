import { randomUUID } from "node:crypto";
import {
  CollaborationAcceptInvitationRequestSchema,
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationCreateAiRequestSchema,
  CollaborationAiRequestControlSchema,
  CollaborationApprovalDecisionRequestSchema,
  CollaborationAiRequestsResponseSchema,
  CollaborationConnectionTicketResponseSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationInvitationSchema,
  CollaborationPageRequestSchema,
  CollaborationProjectSchema,
  CollaborationScopeSchema,
  CollaborationResourceIdSchema,
  CollaborationTerminalFrameSchema,
  CollaborationTerminalSchema,
} from "@matrix-os/contracts";
import { defineCommand } from "citty";
import { z } from "zod/v4";
import { requireCliAuthToken } from "../auth-state.js";
import { cliError, formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ScopeIdSchema = z.uuid();
const RevisionSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const COLLABORATION_PATH = /^\/api\/collaboration\/(?:inbox|shared|invitations\/[0-9a-f-]+(?:\/accept)?|scopes\/[0-9a-f-]+(?:\/chat(?:\/messages|\/requests(?:\/[A-Za-z0-9_.:-]+\/(?:cancel|retry))?|\/approvals\/[A-Za-z0-9_.:-]+\/decision)?|\/terminal(?:\/actions)?|\/connection-tickets|\/user-state)?)?(?:\?[^#]*)?$/i;
const MAX_TERMINAL_FRAME_BYTES = 80 * 1024;
const TERMINAL_HEARTBEAT_MS = 10_000;

interface CollaborationRequestInput {
  platformUrl: string;
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

interface CollaborationTerminalSocket {
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): CollaborationTerminalSocket;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

type CollaborationTerminalSocketConstructor = new (url: string) => CollaborationTerminalSocket;

export function createCollaborationTerminalWebSocketUrl(platformUrl: string, scopeId: string, ticket: string): string {
  const base = new URL(platformUrl);
  if (!base.hostname || !["https:", "http:"].includes(base.protocol) || base.username || base.password
    || base.pathname !== "/" || base.search || base.hash) throw cliError("collaboration_failed");
  const parsedScopeId = ScopeIdSchema.parse(scopeId);
  const parsedTicket = CollaborationConnectionTicketResponseSchema.shape.ticket.parse(ticket);
  const url = new URL(`/ws/collaboration/scopes/${parsedScopeId}/terminal`, base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", parsedTicket);
  return url.href;
}

export async function watchCollaborationTerminal(options: {
  platformUrl: string;
  token: string;
  scopeId: string;
  control?: "acquire" | "takeover";
  input?: string;
  paste?: boolean;
  request?: typeof collaborationRequest;
  WebSocketImpl?: CollaborationTerminalSocketConstructor;
  writeOutput?: (value: string) => void;
  writeState?: (value: unknown) => void;
}): Promise<void> {
  const scopeId = ScopeIdSchema.parse(options.scopeId);
  if (options.input !== undefined && (options.input.length < 1
    || new TextEncoder().encode(options.input).byteLength > 32 * 1024)) throw cliError("collaboration_failed");
  const request = options.request ?? collaborationRequest;
  const ticket = CollaborationConnectionTicketResponseSchema.parse(await request({
    platformUrl: options.platformUrl,
    token: options.token,
    method: "POST",
    path: `/api/collaboration/scopes/${scopeId}/connection-tickets`,
    body: { clientRequestId: randomUUID(), purpose: "terminal" },
  }));
  const WebSocketImpl = options.WebSocketImpl
    ?? await import("ws").then((module) => module.WebSocket as unknown as CollaborationTerminalSocketConstructor);
  if (!WebSocketImpl) throw cliError("collaboration_failed");
  const socket = new WebSocketImpl(createCollaborationTerminalWebSocketUrl(options.platformUrl, scopeId, ticket.ticket));
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(value));
  const writeState = options.writeState ?? ((value: unknown) => console.error(JSON.stringify(value)));
  let connectionId: string | null = null;
  let incarnation: string | null = null;
  let leaseEpoch: string | null = null;
  let phase: "watching" | "acquiring" | "controlling" | "sending" | "releasing" = "watching";
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (error) reject(cliError("collaboration_failed"));
      else resolve();
    };
    const send = (value: Record<string, unknown>) => {
      socket.send(JSON.stringify({ ...value, clientRequestId: randomUUID(), incarnation, connectionId }));
    };
    socket.on("open", () => {
      heartbeat = setInterval(() => {
        if (phase === "controlling" && leaseEpoch) send({ type: "renew", leaseEpoch });
        else socket.send(JSON.stringify({ version: 1, type: "heartbeat" }));
      }, TERMINAL_HEARTBEAT_MS);
      heartbeat.unref?.();
    });
    socket.on("message", (raw) => {
      try {
        const text = terminalFrameText(raw);
        const frame = CollaborationTerminalFrameSchema.parse(JSON.parse(text) as unknown);
        if (frame.scopeId !== scopeId) throw new Error("Scope mismatch");
        if (frame.type === "terminal.output") {
          writeOutput(frame.data);
          return;
        }
        if (frame.type === "terminal.refresh_required") {
          writeState({ type: frame.type, sequence: frame.sequence });
          return;
        }
        if (frame.type === "terminal.unavailable") {
          writeState({ type: frame.type, code: frame.code });
          socket.close(1000, "Unavailable");
          return;
        }
        writeState({ type: frame.type, terminal: frame.terminal });
        if (frame.type === "terminal.ready") {
          connectionId = frame.connectionId;
          incarnation = frame.incarnation;
          if (options.control) {
            phase = "acquiring";
            send({ type: options.control });
          }
          return;
        }
        if (phase === "acquiring" && frame.terminal.controller) {
          leaseEpoch = frame.terminal.controller.leaseEpoch;
          if (options.input !== undefined) {
            phase = "sending";
            send({ type: options.paste ? "paste" : "input", leaseEpoch, data: options.input });
          } else {
            phase = "controlling";
          }
          return;
        }
        if (phase === "sending" && leaseEpoch) {
          phase = "releasing";
          send({ type: "release", leaseEpoch });
          return;
        }
        if (phase === "releasing" && !frame.terminal.controller) socket.close(1000, "Complete");
      } catch (error: unknown) {
        console.warn("[cli-collaboration] terminal frame rejected", error instanceof Error ? error.name : "UnknownError");
        socket.close(1008, "Invalid frame");
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
  });
}

function terminalFrameText(value: unknown): string {
  let bytes: Uint8Array;
  if (typeof value === "string") bytes = new TextEncoder().encode(value);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new Error("Invalid terminal frame");
  if (bytes.byteLength > MAX_TERMINAL_FRAME_BYTES) throw new Error("Terminal frame too large");
  return new TextDecoder().decode(bytes);
}

export async function collaborationRequest(input: CollaborationRequestInput): Promise<unknown> {
  if (!COLLABORATION_PATH.test(input.path)) throw cliError("collaboration_failed");
  let base: URL;
  try {
    base = new URL(input.platformUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw cliError("collaboration_failed");
    throw error;
  }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) {
    throw cliError("collaboration_failed");
  }
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  let response: Response;
  try {
    response = await fetch(new URL(input.path, `${base.toString().replace(/\/+$/, "")}/`).toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException || error instanceof TypeError) throw cliError("collaboration_failed");
    throw error;
  }
  if (!response.ok) throw cliError("collaboration_failed");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw cliError("collaboration_failed");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw cliError("collaboration_failed");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw cliError("collaboration_failed");
    throw error;
  }
}

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  platform: { type: "string", required: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;

const discoveryArgs = {
  ...commonArgs,
  cursor: { type: "string", required: false },
  limit: { type: "string", required: false, default: "50" },
} as const;

export function collaborationDiscoveryPath(
  kind: "inbox" | "shared",
  input: { cursor?: unknown; limit?: unknown },
): string {
  const page = CollaborationPageRequestSchema.parse({
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor) query.set("cursor", page.cursor);
  return `/api/collaboration/${kind}?${query.toString()}`;
}

function value(args: Record<string, unknown>, key: string, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(args[key]);
  if (!parsed.success) throw cliError("collaboration_failed");
  return parsed.data;
}

function writeResult(result: unknown, json: boolean): void {
  const data = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { result };
  console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
}

async function run(
  args: Record<string, unknown>,
  operation: (platformUrl: string, token: string) => Promise<unknown>,
): Promise<void> {
  const json = args.json === true;
  try {
    const profile = await resolveCliProfile(args);
    const token = await requireCliAuthToken(profile);
    writeResult(await operation(profile.platformUrl, token), json);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "collaboration_failed";
    const authMessage = (code === "not_authenticated" || code === "auth_expired") && error instanceof Error
      ? error.message
      : undefined;
    console.error(json ? formatCliError(code, authMessage) : authMessage ?? "Error: Collaboration request failed.");
    process.exitCode = 1;
  }
}

const scopeArgs = {
  ...commonArgs,
  scope: { type: "string", required: true },
} as const;

const controlArgs = {
  ...scopeArgs,
  revision: { type: "string", required: true },
  request: { type: "string", required: true },
} as const;

export const collaborationCommand = defineCommand({
  meta: { name: "collaboration", description: "Access Chats, terminals, and projects shared with your account" },
  subCommands: {
    inbox: defineCommand({
      meta: { name: "inbox", description: "List pending collaboration invitations" },
      args: discoveryArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) =>
        CollaborationDiscoveryResponseSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: collaborationDiscoveryPath("inbox", args),
        }))),
    }),
    shared: defineCommand({
      meta: { name: "shared", description: "List accepted shared items" },
      args: discoveryArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) =>
        CollaborationDiscoveryResponseSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: collaborationDiscoveryPath("shared", args),
        }))),
    }),
    accept: defineCommand({
      meta: { name: "accept", description: "Accept a collaboration invitation" },
      args: {
        ...commonArgs,
        invitation: { type: "string", required: true },
        revision: { type: "string", required: true },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const invitationId = value(args, "invitation", ScopeIdSchema);
        const expectedRevision = value(args, "revision", RevisionSchema);
        const invitation = CollaborationInvitationSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: `/api/collaboration/invitations/${invitationId}`,
        }));
        return collaborationRequest({
          platformUrl,
          token,
          method: "POST",
          path: `/api/collaboration/invitations/${invitationId}/accept`,
          body: CollaborationAcceptInvitationRequestSchema.parse({
            clientRequestId: randomUUID(),
            expectedRevision,
          }),
        }).then((accepted) => ({ invitation, accepted }));
      }),
    }),
    open: defineCommand({
      meta: { name: "open", description: "Read a shared Chat without owner-home access" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const request = (path: string) => collaborationRequest({ platformUrl, token, method: "GET", path });
        const [scope, chat, messages] = await Promise.all([
          request(`/api/collaboration/scopes/${scopeId}`).then((data) => CollaborationScopeSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/chat`).then((data) => CollaborationChatSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/chat/messages?after=0&limit=100`)
            .then((data) => CollaborationChatMessagesResponseSchema.parse(data)),
        ]);
        return { scope, chat, messages: messages.messages };
      }),
    }),
    discuss: defineCommand({
      meta: { name: "discuss", description: "Post a human discussion message to a shared Chat" },
      args: {
        ...scopeArgs,
        revision: { type: "string", required: true },
        message: { type: "string", required: true },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const expectedRevision = value(args, "revision", RevisionSchema);
        const body = CollaborationCreateDiscussionRequestSchema.parse({
          clientRequestId: randomUUID(),
          expectedRevision,
          text: args.message,
        });
        return collaborationRequest({
          platformUrl,
          token,
          method: "POST",
          path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
          body,
        });
      }),
    }),
    requests: defineCommand({
      meta: { name: "requests", description: "List the ordered shared AI queue" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        return CollaborationAiRequestsResponseSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: `/api/collaboration/scopes/${scopeId}/chat/requests`,
        }));
      }),
    }),
    ask: defineCommand({
      meta: { name: "ask", description: "Add an attributed request to the shared AI queue" },
      args: {
        ...scopeArgs,
        revision: { type: "string", required: true },
        message: { type: "string", required: true },
        instance: { type: "string", required: false, default: "claude_shared" },
        model: { type: "string", required: false, default: "claude-opus-4-6" },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const body = CollaborationCreateAiRequestSchema.parse({
          clientRequestId: randomUUID(),
          expectedRevision: value(args, "revision", RevisionSchema),
          text: args.message,
          selection: { instanceId: args.instance, model: args.model },
        });
        return collaborationRequest({
          platformUrl, token, method: "POST",
          path: `/api/collaboration/scopes/${scopeId}/chat/requests`, body,
        });
      }),
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel an eligible shared AI request" },
      args: controlArgs,
      run: async ({ args }) => run(args, (platformUrl, token) => requestControl(platformUrl, token, args, "cancel")),
    }),
    retry: defineCommand({
      meta: { name: "retry", description: "Retry an eligible shared AI request as a new attempt" },
      args: controlArgs,
      run: async ({ args }) => run(args, (platformUrl, token) => requestControl(platformUrl, token, args, "retry")),
    }),
    approve: defineCommand({
      meta: { name: "approve", description: "Submit an owner decision for a shared AI approval" },
      args: {
        ...scopeArgs,
        revision: { type: "string", required: true },
        approval: { type: "string", required: true },
        run: { type: "string", required: true },
        decision: { type: "string", required: true },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const approvalId = value(args, "approval", CollaborationResourceIdSchema);
        const body = CollaborationApprovalDecisionRequestSchema.parse({
          clientRequestId: randomUUID(),
          expectedRevision: value(args, "revision", RevisionSchema),
          runId: value(args, "run", CollaborationResourceIdSchema),
          decision: args.decision,
        });
        return collaborationRequest({
          platformUrl, token, method: "POST",
          path: `/api/collaboration/scopes/${scopeId}/chat/approvals/${approvalId}/decision`, body,
        });
      }),
    }),
    terminal: defineCommand({
      meta: { name: "terminal", description: "Read a shared terminal and its current controller" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const request = (path: string) => collaborationRequest({ platformUrl, token, method: "GET", path });
        const [scope, terminal] = await Promise.all([
          request(`/api/collaboration/scopes/${scopeId}`).then((data) => CollaborationScopeSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/terminal`).then((data) => CollaborationTerminalSchema.parse(data)),
        ]);
        if (scope.kind !== "terminal" || terminal.scopeId !== scope.id) throw cliError("collaboration_failed");
        return { scope, terminal };
      }),
    }),
    project: defineCommand({
      meta: { name: "project", description: "Read a shared project's complete inherited inventory" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const request = (path: string) => collaborationRequest({ platformUrl, token, method: "GET", path });
        const [scope, project] = await Promise.all([
          request(`/api/collaboration/scopes/${scopeId}`).then((data) => CollaborationScopeSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/project`).then((data) => CollaborationProjectSchema.parse(data)),
        ]);
        if (scope.kind !== "project" || project.scopeId !== scope.id || project.id !== scope.resourceId) {
          throw cliError("collaboration_failed");
        }
        return { scope, project };
      }),
    }),
    "terminal-watch": defineCommand({
      meta: { name: "terminal-watch", description: "Watch shared terminal output and optionally send one fenced input" },
      args: {
        ...scopeArgs,
        control: { type: "boolean", required: false, default: false },
        takeover: { type: "boolean", required: false, default: false },
        input: { type: "string", required: false },
        paste: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const input = typeof args.input === "string" ? args.input : undefined;
        const control = args.takeover === true ? "takeover" as const
          : args.control === true || input !== undefined ? "acquire" as const : undefined;
        await watchCollaborationTerminal({
          platformUrl,
          token,
          scopeId,
          ...(control ? { control } : {}),
          ...(input !== undefined ? { input, paste: args.paste === true } : {}),
        });
        return { status: "disconnected", scopeId };
      }),
    }),
    "terminal-stop": defineCommand({
      meta: { name: "terminal-stop", description: "Stop an owned or creator-eligible shared terminal" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const terminal = CollaborationTerminalSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: `/api/collaboration/scopes/${scopeId}/terminal`,
        }));
        return collaborationRequest({
          platformUrl,
          token,
          method: "POST",
          path: `/api/collaboration/scopes/${scopeId}/terminal/actions`,
          body: { type: "stop", clientRequestId: randomUUID(), incarnation: terminal.incarnation },
        });
      }),
    }),
  },
  run: () => console.log("Usage: matrix collaboration inbox|shared|accept|open|discuss|requests|ask|cancel|retry|approve|terminal|terminal-watch|terminal-stop|project"),
});

async function requestControl(
  platformUrl: string,
  token: string,
  args: Record<string, unknown>,
  action: "cancel" | "retry",
): Promise<unknown> {
  const scopeId = value(args, "scope", ScopeIdSchema);
  const requestId = value(args, "request", CollaborationResourceIdSchema);
  const body = CollaborationAiRequestControlSchema.parse({
    clientRequestId: randomUUID(),
    expectedRevision: value(args, "revision", RevisionSchema),
  });
  return collaborationRequest({
    platformUrl, token, method: "POST",
    path: `/api/collaboration/scopes/${scopeId}/chat/requests/${requestId}/${action}`, body,
  });
}
