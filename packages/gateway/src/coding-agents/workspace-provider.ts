import {
  AgentThreadEventSchema,
  ProviderIdSchema,
  TerminalSessionIdSchema,
  type AgentProviderSummary,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type SafeSetupAction,
} from "@matrix-os/contracts";
import { SupportedAgentSchema, type SupportedAgent } from "../agent-launcher.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodingAgentProviderAdapter } from "./thread-store.js";

type WorkspaceRuntime = Pick<WorkspaceSessionOrchestrator, "startSession" | "stopSession">;

export interface WorkspaceCodingAgentProviderOptions {
  providerId: string;
  agent: SupportedAgent;
  runtime: WorkspaceRuntime;
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

  return {
    providerId,
    getSummary({ now }) {
      return {
        id: providerId,
        displayName: providerDisplayName(agent),
        kind: providerKind(agent),
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "review"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: now().toISOString(),
      };
    },
    healthCheck() {
      return { ok: true };
    },
    buildSetupAction(): SafeSetupAction[] {
      return [];
    },
    async startThread({ principal, thread, request, now, nextEventId }) {
      const sessionId = sessionIdForThread(thread.id);
      const result = await options.runtime.startSession({
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
          approvalPolicy: request.approvalPolicy,
          sandboxMode: request.sandboxMode,
          runtimePreference: "zellij",
        },
      });
      if (!result.ok) {
        throw new Error("Workspace provider start failed");
      }

      const terminalSessionId = terminalSessionIdFor(result.session);
      return [
        statusEvent({
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
        }),
        AgentThreadEventSchema.parse({
          type: "assistant.text.delta",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          messageId: `msg_${thread.id}`,
          delta: "Agent session started.",
        }),
      ];
    },
    async abortThread({ thread, now, nextEventId }) {
      const result = await options.runtime.stopSession(sessionIdForThread(thread.id));
      if (!result.ok) {
        throw new Error("Workspace provider abort failed");
      }
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
    submitApproval() {
      return [];
    },
    submitInput() {
      return [];
    },
  };
}
