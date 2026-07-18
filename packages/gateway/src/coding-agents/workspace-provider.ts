import {
  AgentThreadEventSchema,
  CODEX_VERIFIED_NPM_PACKAGE,
  ProviderIdSchema,
  SafeSetupActionSchema,
  TerminalSessionIdSchema,
  type AgentProviderSummary,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type SafeSetupAction,
} from "@matrix-os/contracts";
import { SupportedAgentSchema, type SupportedAgent } from "../agent-launcher.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodingAgentProviderAdapter } from "./thread-store.js";
import type { CodexEventBridge } from "./codex-event-bridge.js";
import type { CodexControlClient } from "./codex-control-client.js";

type WorkspaceRuntime = Pick<WorkspaceSessionOrchestrator, "startSession" | "stopSession"> &
  Partial<Pick<WorkspaceSessionOrchestrator, "sendInput">>;
type SetupAgent = Extract<SupportedAgent, "claude" | "codex">;

const SETUP_AGENTS: Record<SetupAgent, { installPackage: string; connectCommand: string }> = {
  claude: {
    installPackage: "@anthropic-ai/claude-code@latest",
    connectCommand: "claude",
  },
  codex: {
    installPackage: CODEX_VERIFIED_NPM_PACKAGE,
    connectCommand: "codex login",
  },
};

export interface WorkspaceCodingAgentProviderOptions {
  providerId: string;
  agent: SupportedAgent;
  runtime: WorkspaceRuntime;
  runnable?: boolean;
  codexEvents?: Pick<CodexEventBridge, "healthCheck" | "watch" | "unwatch" | "markStopped">;
  codexControl?: CodexControlClient;
}

export interface WorkspaceCodingAgentProviderSetOptions {
  agents: readonly SupportedAgent[];
  runtime: WorkspaceRuntime;
  codexEvents?: Pick<CodexEventBridge, "healthCheck" | "watch" | "unwatch" | "markStopped">;
  codexControl?: CodexControlClient;
}

export interface WorkspaceCodingAgentProviderSet {
  registryProviders: CodingAgentProviderAdapter[];
  executionProviders: CodingAgentProviderAdapter[];
  approvalsEnabled: boolean;
}

function sessionIdForThread(threadId: string): string {
  return `sess_${threadId.slice("thread_".length)}`;
}

function providerDisplayName(agent: SupportedAgent): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  return "Pi";
}

function providerKind(agent: SupportedAgent): AgentProviderSummary["kind"] {
  if (agent === "claude") return "claude";
  if (agent === "codex") return "codex";
  if (agent === "opencode") return "opencode";
  return "custom";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function visibleSetupCommand(command: string): string {
  const foreground = [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    command,
    'exec "${SHELL:-sh}" -l',
  ].join("; ");
  return `sh -lc ${shellQuote(foreground)}`;
}

function visibleInstallCommand(installPackage: string): string {
  return visibleSetupCommand(
    `npm install -g --prefix "$MATRIX_NODE_PREFIX" ${installPackage}`,
  );
}

function providerSetupActions(agent: SupportedAgent): SafeSetupAction[] {
  if (agent !== "claude" && agent !== "codex") return [];
  const displayName = providerDisplayName(agent);
  const setup = SETUP_AGENTS[agent];
  return SafeSetupActionSchema.array().max(2).parse([
    {
      id: `${agent}_install`,
      kind: "foreground_terminal",
      label: `Install ${displayName}`,
      command: visibleInstallCommand(setup.installPackage),
    },
    {
      id: `${agent}_connect`,
      kind: "foreground_terminal",
      label: `Connect ${displayName}`,
      command: visibleSetupCommand(setup.connectCommand),
    },
  ]);
}

function terminalSessionIdFor(session: {
  runtime?: { zellijSession?: unknown } | null;
  terminalSessionId?: unknown;
  id?: unknown;
}): string {
  const candidates = [
    session.runtime?.zellijSession,
    session.terminalSessionId,
    session.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && TerminalSessionIdSchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  throw new Error("Workspace provider terminal binding failed");
}

function runningStatusFor(session: { runtime?: { status?: unknown } | null }): "starting" | "running" {
  return session.runtime?.status === "starting" ? "starting" : "running";
}

function workspaceTurnInput(
  message: string,
  attachments: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0]["turn"]["attachments"],
): string {
  const references = (attachments ?? [])
    .filter((attachment) => attachment.kind === "structured_ref")
    .map((attachment) => `- ${attachment.label}${attachment.path ? `: ${attachment.path}` : ""}`);
  const body = references.length > 0
    ? `${message}\n\nContext references:\n${references.join("\n")}`
    : message;
  if (Buffer.byteLength(body, "utf-8") > 64 * 1024) {
    throw new Error("Workspace provider input is too large");
  }
  return `matrix-turn-v1:${Buffer.from(body, "utf-8").toString("base64")}\r`;
}

function statusEvent(input: {
  threadId: string;
  status: "starting" | "running" | "aborted";
  now: () => Date;
  nextEventId: () => string;
}): AgentThreadEvent {
  return AgentThreadEventSchema.parse({
    type: "thread.status",
    eventId: input.nextEventId(),
    threadId: input.threadId,
    occurredAt: input.now().toISOString(),
    status: input.status,
  });
}

function completedEvent(input: {
  threadId: string;
  outcome: "aborted";
  now: () => Date;
  nextEventId: () => string;
}): AgentThreadEvent {
  return AgentThreadEventSchema.parse({
    type: "thread.completed",
    eventId: input.nextEventId(),
    threadId: input.threadId,
    occurredAt: input.now().toISOString(),
    outcome: input.outcome,
  });
}

export function createWorkspaceCodingAgentProvider(
  options: WorkspaceCodingAgentProviderOptions,
): CodingAgentProviderAdapter {
  const providerId = ProviderIdSchema.parse(options.providerId);
  const agent = SupportedAgentSchema.parse(options.agent);
  const runnable = options.runnable !== false;

  return {
    providerId,
    async getSummary({ now, signal }) {
      const executable = runnable && (
        agent !== "codex" || !options.codexEvents || (await options.codexEvents.healthCheck(signal)).ok
      );
      return {
        id: providerId,
        displayName: providerDisplayName(agent),
        kind: providerKind(agent),
        availability: executable ? "available" : "unavailable",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "review"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: now().toISOString(),
      };
    },
    async healthCheck({ signal }) {
      if (!runnable) return { ok: false };
      if (agent === "codex" && options.codexEvents) return options.codexEvents.healthCheck(signal);
      return { ok: true };
    },
    buildSetupAction(): SafeSetupAction[] {
      return providerSetupActions(agent);
    },
    async startThread({ principal, thread, request, now, nextEventId }) {
      if (!runnable) {
        throw new Error("Workspace provider execution unavailable");
      }
      const sessionId = sessionIdForThread(thread.id);
      if (agent === "codex" && options.codexEvents) {
        await options.codexEvents.watch({
          principal,
          threadId: thread.id,
          sessionId,
        });
      }
      let result;
      try {
        result = await options.runtime.startSession({
          ownerScope: { type: "user", id: principal.userId },
          request: {
            sessionId,
            kind: "agent",
            agent,
            prompt: request.prompt,
            attachments: request.attachments,
            projectSlug: request.projectId,
            taskId: request.taskId,
            worktreeId: request.worktreeId,
            mode: request.mode,
            approvalPolicy: agent === "codex" && !options.codexControl
              ? "never"
              : request.approvalPolicy,
            sandboxMode: request.sandboxMode,
            runtimePreference: "zellij",
          },
        });
      } catch (error: unknown) {
        options.codexEvents?.unwatch(sessionId);
        throw error;
      }
      if (!result.ok) {
        options.codexEvents?.unwatch(sessionId);
        throw new Error("Workspace provider start failed");
      }

      const terminalSessionId = terminalSessionIdFor(result.session);
      return {
        events: [statusEvent({
          threadId: thread.id,
          status: runningStatusFor(result.session),
          now,
          nextEventId,
        }),
        AgentThreadEventSchema.parse({
          type: "terminal.bound",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          terminalSessionId,
        })],
        resumeState: { conversationId: sessionId },
      };
    },
    async resumeTurn({ thread, turn, resumeState, signal }) {
      if (!runnable || !options.runtime.sendInput) {
        throw new Error("Workspace provider turn resume unavailable");
      }
      const sessionId = sessionIdForThread(thread.id);
      if (resumeState.conversationId !== sessionId) {
        throw new Error("Workspace provider conversation mismatch");
      }
      signal.throwIfAborted();
      const result = await options.runtime.sendInput(
        sessionId,
        workspaceTurnInput(turn.message, turn.attachments),
        signal,
      );
      if (!result.ok) throw new Error("Workspace provider turn resume failed");
      return { events: [], outcome: "delivered", resumeState };
    },
    async abortThread({ thread, now, nextEventId }) {
      const result = await options.runtime.stopSession(sessionIdForThread(thread.id));
      if (!result.ok) {
        throw new Error("Workspace provider abort failed");
      }
      options.codexEvents?.markStopped(sessionIdForThread(thread.id));
      return [
        statusEvent({
          threadId: thread.id,
          status: "aborted",
          now,
          nextEventId,
        }),
        completedEvent({
          threadId: thread.id,
          outcome: "aborted",
          now,
          nextEventId,
        }),
      ];
    },
    async submitApproval({ thread, approvalId, request }) {
      if (agent !== "codex" || !options.codexControl) {
        throw new Error("Workspace provider approval unavailable");
      }
      await options.codexControl.submitApproval({
        sessionId: sessionIdForThread(thread.id),
        approvalId,
        decision: request.decision,
        clientRequestId: request.clientRequestId,
      });
      return [];
    },
    async submitInput({ thread, inputRequestId, request }) {
      if (agent !== "codex" || !options.codexControl || !request.structuredAnswers) {
        throw new Error("Workspace provider input unavailable");
      }
      await options.codexControl.submitInput({
        sessionId: sessionIdForThread(thread.id),
        inputRequestId,
        structuredAnswers: request.structuredAnswers,
        clientRequestId: request.clientRequestId,
      });
      return [];
    },
  };
}

export function createWorkspaceCodingAgentProviderSet(
  options: WorkspaceCodingAgentProviderSetOptions,
): WorkspaceCodingAgentProviderSet {
  const agents = SupportedAgentSchema.array().max(4).parse(options.agents);
  const registryProviders = agents.map((agent) => createWorkspaceCodingAgentProvider({
    providerId: agent,
    agent,
    runtime: options.runtime,
    runnable: agent === "codex" || agent === "claude",
    codexEvents: agent === "codex" ? options.codexEvents : undefined,
    codexControl: agent === "codex" ? options.codexControl : undefined,
  }));
  return {
    registryProviders,
    executionProviders: registryProviders,
    approvalsEnabled: agents.includes("codex") && Boolean(options.codexControl),
  };
}
