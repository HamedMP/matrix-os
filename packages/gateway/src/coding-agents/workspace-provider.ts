import { nativeCodexRoutineAdmission } from "../chat/codex-routine-source.js";
import { prepareCodexBrowser } from "./codex-browser-bootstrap-client.js";
import { beginNativeBrowserBootstrap, markNativeBrowserCleanupUnconfirmed, nativeBrowserExecution } from "../chat/native-browser-execution-context.js";
import type { SessionStartScope } from "../session-start-guard.js";
import type { CodexExecutionAdmission } from "./codex-execution-admission.js";
import { join } from "node:path";
import { boundedOperation } from "../bounded-operation.js";
import {
  AgentThreadEventSchema,
  CODEX_VERIFIED_NPM_PACKAGE,
  ProviderIdSchema,
  SafeSetupActionSchema,
  TerminalRefSchema,
  type AgentProviderSummary,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type SafeSetupAction,
} from "@matrix-os/contracts";
import { SupportedAgentSchema, type SupportedAgent } from "../agent-launcher.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import { createPiCodingAgentProvider, type PiCodingAgentProviderOptions } from "./pi-provider.js";
import {
  createOpenCodeCodingAgentProvider,
  type OpenCodeCodingAgentProviderOptions,
} from "./opencode-provider.js";
import type { CodingAgentProviderAdapter } from "./thread-store.js";
import type { CodexEventBridge } from "./codex-event-bridge.js";
import type { CodexControlClient } from "./codex-control-client.js";
import { recoverCodexWorkspace } from "./codex-workspace-recovery.js";
import { proveCodexResumeStopped } from "./provider-transcript-recovery.js";
import type { BackgroundAgentRuntime } from "../background-agent-runtime.js";

type WorkspaceRuntime = Pick<WorkspaceSessionOrchestrator, "startSession" | "stopSession"> &
  Partial<Pick<WorkspaceSessionOrchestrator, "sendInput" | "getSession" | "withSessionStart">>;
type SetupAgent = Extract<SupportedAgent, "claude" | "codex">;

const SETUP_AGENTS: Record<SetupAgent, { installPackage: string; connectCommand: string }> = {
  claude: {
    installPackage: "@anthropic-ai/claude-code@latest",
    connectCommand: "claude",
  },
  codex: {
    installPackage: CODEX_VERIFIED_NPM_PACKAGE,
    connectCommand: "codex login --device-auth",
  },
};

export interface WorkspaceCodingAgentProviderOptions {
  providerId: string;
  agent: SupportedAgent;
  runtime: WorkspaceRuntime;
  runnable?: boolean;
  codexEvents?: Pick<CodexEventBridge, "healthCheck" | "watch" | "unwatch" | "markStopped"> & Partial<Pick<CodexEventBridge, "isRuntimeAlive">>;
  codexControl?: CodexControlClient;
  sharedBrowserEnabled?: boolean;
  codexAdmission?: CodexExecutionAdmission;
  backgroundRuntime?: Pick<BackgroundAgentRuntime, "isRunning" | "stop">;
}

export interface WorkspaceCodingAgentProviderSetOptions {
  agents: readonly SupportedAgent[];
  runtime: WorkspaceRuntime;
  codexEvents?: Pick<CodexEventBridge, "healthCheck" | "watch" | "unwatch" | "markStopped"> & Partial<Pick<CodexEventBridge, "isRuntimeAlive">>;
  codexControl?: CodexControlClient;
  sharedBrowserEnabled?: boolean;
  codexAdmission?: CodexExecutionAdmission;
  backgroundRuntime?: Pick<BackgroundAgentRuntime, "isRunning" | "stop">;
  homePath?: string;
  pi?: Omit<PiCodingAgentProviderOptions, "homePath">;
  opencode?: Omit<OpenCodeCodingAgentProviderOptions, "homePath">;
}

export interface WorkspaceCodingAgentProviderSet {
  registryProviders: CodingAgentProviderAdapter[];
  executionProviders: CodingAgentProviderAdapter[];
  approvalsEnabled: boolean;
}

function defaultMatrixHome(): string {
  const configured = process.env.MATRIX_HOME?.trim();
  if (configured) return configured;
  return join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "matrixos");
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

function safeRecoveryErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (name === "Error" || name === "AbortError" || name === "TimeoutError"
    || name === "CodexControlUnavailableError" || name === "CodexControlTransportError"
    || name === "CodexControlRejectedError") {
    return name;
  }
  return "UnknownError";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function visibleSetupCommand(command: string): string {
  const foreground = [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    command,
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

function terminalRefFor(session: { terminalRef?: unknown; runtime?: { type?: string } }) {
  if (session.runtime?.type === "background") return undefined;
  const parsed = TerminalRefSchema.safeParse(session.terminalRef);
  if (parsed.success) return parsed.data;
  throw new Error("Workspace provider terminal binding failed");
}

function runningStatusFor(session: { runtime?: { status?: unknown } | null }): "starting" | "running" {
  return session.runtime?.status === "starting" ? "starting" : "running";
}

function workspaceTurnPrompt(
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
  return body;
}

function workspaceTurnInput(
  message: string,
  attachments: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0]["turn"]["attachments"],
  model: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0]["turn"]["model"],
  modelOptions: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0]["turn"]["modelOptions"],
): string {
  const body = workspaceTurnPrompt(message, attachments);
  const payload = JSON.stringify({ prompt: body, model, modelOptions: modelOptions ?? [] });
  if (Buffer.byteLength(payload, "utf-8") > 66 * 1024) {
    throw new Error("Workspace provider input is too large");
  }
  return `matrix-turn-v2:${Buffer.from(payload, "utf-8").toString("base64")}\r`;
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
  if (agent === "codex" && options.sharedBrowserEnabled && (!options.codexEvents || !options.codexControl?.prepareBrowser)) throw new Error("Browser control unavailable");

  return {
    providerId,
    ...(agent === "codex" && options.codexControl && options.codexEvents ? {
      async prepareHistoryResume(input: Parameters<typeof proveCodexResumeStopped>[0]) {
        if (!await proveCodexResumeStopped(input, { runtime: options.runtime, control: options.codexControl,
          admission: options.codexAdmission, backgroundRuntime: options.backgroundRuntime })) throw new Error("Native resume stop unconfirmed");
      },
    } : {}),
    backgroundExecution: agent === "codex" && !!options.codexEvents && !!options.codexControl,
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
        authStatus: agent === "codex" ? "unknown" : "authenticated",
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
    async startThread({ principal, thread, request, signal, now, nextEventId }) {
      if (!runnable) {
        throw new Error("Workspace provider execution unavailable");
      }
      const sessionId = sessionIdForThread(thread.id);
      const start = async (scope?: SessionStartScope<Parameters<WorkspaceRuntime["startSession"]>[0], Awaited<ReturnType<WorkspaceRuntime["startSession"]>>>) => {
        const browser = agent === "codex" ? nativeBrowserExecution(principal.userId) : undefined;
        if (agent === "codex") nativeCodexRoutineAdmission(principal.userId)?.prepare(sessionId);
        if (browser && !options.codexControl?.prepareBrowser) throw new Error("Browser startup unavailable");
        const nativeAccountBinding = agent === "codex" ? await options.codexAdmission?.start(principal.userId, sessionId) : undefined;
        let result;
        let runtimeInvoked = false;
        let startup: ReturnType<typeof beginNativeBrowserBootstrap>;
        try {
          if (agent === "codex" && options.codexEvents) {
            await options.codexEvents.watch({
              principal,
              threadId: thread.id,
              sessionId,
              ...(options.codexControl ? { checkpoint: true } : {}),
            });
          }
          if (agent === "codex") await options.codexAdmission?.validate(principal.userId, nativeAccountBinding, sessionId);
          // Keep physical startup and MCP binding tracked without marking
          // manager-proved predispatch failures as uncertain processes.
          startup = browser ? beginNativeBrowserBootstrap(principal.userId) : undefined;
          runtimeInvoked = true;
          try {
            result = await (scope?.startSession ?? options.runtime.startSession)({
              ownerScope: { type: "user", id: principal.userId },
              request: {
                sessionId,
                kind: "agent",
                agent,
                prompt: request.prompt,
                attachments: request.attachments,
                model: request.model,
                modelOptions: request.modelOptions,
                projectSlug: request.projectId,
                taskId: request.taskId,
                worktreeId: request.worktreeId,
                mode: request.mode,
                approvalPolicy: agent === "codex" && !options.codexControl
                  ? "never"
                  : request.approvalPolicy,
                sandboxMode: request.sandboxMode,
                runtimePreference: agent === "codex" && options.codexEvents && options.codexControl ? "background" : "zellij",
              },
            });
          } catch (error: unknown) {
            if (browser) markNativeBrowserCleanupUnconfirmed(principal.userId);
            throw error;
          }
          if (!result.ok) {
            if (browser && result.error.code === "runtime_ownership_retained") markNativeBrowserCleanupUnconfirmed(principal.userId);
            if (agent === "codex") await options.codexAdmission?.releaseFailedStart(principal.userId, sessionId, nativeAccountBinding, result);
            throw new Error("Workspace provider start failed");
          }
          if (browser) await prepareCodexBrowser({ ownerId: principal.userId, sessionId, browser,
            control: options.codexControl!, runtime: options.runtime, signal: signal ?? new AbortController().signal });
        } catch (error: unknown) {
          options.codexEvents?.unwatch(sessionId);
          // Only the manager-owned reservation can prove a settled predispatch
          // failure clean; HTTP-style not-found is not filesystem absence.
          if (!runtimeInvoked && agent === "codex" && scope) {
            try {
              const proof = await scope.cleanFailure({});
              await options.codexAdmission?.releaseFailedStart(principal.userId, sessionId, nativeAccountBinding, proof);
            } catch (cleanupError: unknown) {
              console.warn("[coding-agents] Native startup cleanup unconfirmed", safeRecoveryErrorName(cleanupError));
            }
          }
          throw error;
        } finally { startup?.finish(); }

        const terminalRef = terminalRefFor(result.session);
        return {
          events: [statusEvent({
            threadId: thread.id,
            status: runningStatusFor(result.session),
            now,
            nextEventId,
          }),
          ...(terminalRef ? [AgentThreadEventSchema.parse({
            type: "terminal.bound",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: now().toISOString(),
            terminalRef,
            terminalSessionId: `${terminalRef.workspaceId}:${terminalRef.tabId}`,
          })] : [])],
          resumeState: { conversationId: sessionId, ...(nativeAccountBinding ? { nativeAccountBinding } : {}), ...(result.session.backgroundRef ? { backgroundRef: result.session.backgroundRef } : {}) },
        };
      };
      return options.runtime.withSessionStart
        ? options.runtime.withSessionStart(principal.userId, sessionId, start) : start();
    },
    async resumeTurn(context) {
      const { principal, thread, turn, resumeState, signal, now, nextEventId } = context;
      if (!runnable) {
        throw new Error("Workspace provider turn resume unavailable");
      }
      const sessionId = sessionIdForThread(thread.id);
      if (resumeState.conversationId !== sessionId) {
        throw new Error("Workspace provider conversation mismatch");
      }
      signal.throwIfAborted();
      if (agent === "codex") await options.codexAdmission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
      if (agent === "codex") nativeCodexRoutineAdmission(principal.userId)?.prepare(sessionId);
      if (agent === "codex" && options.codexControl) {
        if (!options.codexEvents) {
          throw new Error("Codex structured events are unavailable");
        }
        const observation = await options.codexEvents.watch({
          principal,
          threadId: thread.id,
          sessionId,
          startAtEnd: true,
          checkpoint: true,
          ...(resumeState.eventGeneration ? { generation: resumeState.eventGeneration } : {}),
          resume: { turnId: turn.turnId, resumeState, proveStopped: proofSignal => proveCodexResumeStopped({ principal, thread, resumeState, signal: AbortSignal.any([signal, proofSignal]) }, {
            runtime: options.runtime, control: options.codexControl, admission: options.codexAdmission,
            backgroundRuntime: options.backgroundRuntime,
          }) },
        });
        const prompt = workspaceTurnPrompt(turn.message, turn.attachments);
        const browser = nativeBrowserExecution(principal.userId);
        try {
          await options.codexAdmission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
          const privateTurn = await nativeCodexRoutineAdmission(principal.userId)?.queued(sessionId, { prompt, ...(turn.model ? { model: turn.model } : {}), modelOptions: turn.modelOptions ?? [],
            ...(browser ? { browser: { attemptId: browser.attemptId, token: browser.token, gatewayPort: Number(browser.mcpServer.env.MATRIX_SHARED_BROWSER_GATEWAY_PORT) } } : {}) }, `req_${turn.turnId.slice("turn_".length)}`);
          if (!privateTurn) await options.codexControl.submitTurn({
            sessionId,
            turnId: turn.turnId,
            prompt,
            ...(turn.model ? { model: turn.model } : {}),
            modelOptions: turn.modelOptions ?? [],
            ...(browser ? { browser: { attemptId: browser.attemptId, token: browser.token, gatewayPort: Number(browser.mcpServer.env.MATRIX_SHARED_BROWSER_GATEWAY_PORT) } } : {}),
          });
        } catch (error: unknown) {
          signal.throwIfAborted();
          if (!(error instanceof Error) || error.name !== "CodexControlUnavailableError") {
            // An accepted frame with a lost acknowledgement must not be replayed into a new process.
            options.codexEvents.unwatch(sessionId, observation.watchId);
            throw error;
          }
          console.warn(
            "[coding-agents] Codex turn control failed; restarting session",
            { errorName: safeRecoveryErrorName(error) },
          );
          const recovery = browser ? beginNativeBrowserBootstrap(principal.userId) : undefined;
          const recoverySignal = recovery ? AbortSignal.any([signal, recovery.signal]) : signal;
          try {
            if (browser && !options.codexControl.prepareBrowser) throw new Error("Browser startup unavailable");
            await options.codexAdmission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
            const session = await recoverCodexWorkspace(options.runtime, { ...context, signal: recoverySignal }, sessionId, prompt,
              browser ? () => markNativeBrowserCleanupUnconfirmed(principal.userId) : undefined);
            if (browser) {
              await prepareCodexBrowser({ ownerId: principal.userId, sessionId, browser, control: options.codexControl, runtime: options.runtime, signal: recoverySignal });
            }
            const terminalRef = terminalRefFor(session);
            return { events: terminalRef ? [AgentThreadEventSchema.parse({
              type: "terminal.bound", eventId: nextEventId(), threadId: thread.id,
              occurredAt: now().toISOString(), terminalRef,
              terminalSessionId: `${terminalRef.workspaceId}:${terminalRef.tabId}`,
              terminalSessionCreatedAt: session.runtime.createdAt,
            })] : [], outcome: "delivered", resumeState: { ...resumeState, ...(session.backgroundRef ? { backgroundRef: session.backgroundRef } : {}),
              ...(observation.generation ? { eventGeneration: observation.generation, eventStreamInterrupted: false } : {}),
              ...(observation.offset !== undefined ? { eventOffset: observation.offset } : {}) } };
          } catch (recoveryError: unknown) {
            options.codexEvents.unwatch(sessionId, observation.watchId);
            throw recoveryError;
          } finally { recovery?.finish(); }
        }
        return { events: [], outcome: "delivered", resumeState: { ...resumeState,
          ...(observation.generation ? { eventGeneration: observation.generation, eventStreamInterrupted: false, eventOffset: observation.offset } : {}) } };
      }
      if (!options.runtime.sendInput) {
        throw new Error("Workspace provider turn resume unavailable");
      }
      if (agent === "codex") await options.codexAdmission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
      const result = await options.runtime.sendInput(
        sessionId,
        workspaceTurnInput(turn.message, turn.attachments, turn.model, turn.modelOptions),
        signal,
      );
      if (!result.ok) throw new Error("Workspace provider turn resume failed");
      return { events: [], outcome: "delivered", resumeState };
    },
    async steerTurn({ principal, thread, turnId, message, clientRequestId, resumeState }) {
      if (agent !== "codex" || !options.codexControl) {
        throw new Error("Workspace provider steering unavailable");
      }
      const sessionId = sessionIdForThread(thread.id);
      if (resumeState.conversationId !== sessionId) {
        throw new Error("Workspace provider steering target changed");
      }
      await options.codexAdmission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
      await options.codexControl.steerTurn({ sessionId, prompt: message, clientRequestId });
    },
    async abortThread({ thread, clientRequestId, now, nextEventId, requireRuntimeStop }) {
      const sessionId = sessionIdForThread(thread.id);
      if (agent === "codex" && options.codexControl && !requireRuntimeStop) {
        await boundedOperation(() => options.codexControl!.interruptTurn({ sessionId, clientRequestId }), 5_000);
      } else {
        const result = await boundedOperation(() => options.runtime.stopSession(sessionId), 5_000);
        if (!result.ok && !(requireRuntimeStop && result.status === 404 && result.error.code === "not_found")) {
          throw new Error("Workspace provider abort failed");
        }
        options.codexEvents?.markStopped(sessionId);
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
    async submitApproval({ principal, thread, approvalId, request, resumeState }) {
      if (agent !== "codex" || !options.codexControl) {
        throw new Error("Workspace provider approval unavailable");
      }
      await options.codexAdmission?.validate(principal.userId, resumeState?.nativeAccountBinding, sessionIdForThread(thread.id));
      await options.codexControl.submitApproval({
        sessionId: sessionIdForThread(thread.id),
        approvalId,
        decision: request.decision,
        clientRequestId: request.clientRequestId,
      });
      return [];
    },
    async deferInput({ principal, thread, inputRequestId }) {
      if (agent !== "codex" || !options.codexControl) throw new Error("Input deferral unavailable");
      await options.codexAdmission?.validateLaunch(principal.userId, sessionIdForThread(thread.id));
      await options.codexControl.deferInput({ sessionId: sessionIdForThread(thread.id), inputRequestId, clientRequestId: `defer_${inputRequestId}` });
    },
    async submitInput({ principal, thread, inputRequestId, request, resumeState }) {
      if (agent !== "codex" || !options.codexControl || !request.structuredAnswers) {
        throw new Error("Workspace provider input unavailable");
      }
      await options.codexAdmission?.validate(principal.userId, resumeState?.nativeAccountBinding, sessionIdForThread(thread.id));
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
  const registryProviders = agents.map((agent) => {
    // Pi and OpenCode run as direct-spawn JSON-stream adapters, not terminal sessions.
    if (agent === "pi") {
      if (!options.pi?.resolveCredentialLaunch) {
        throw new Error("Pi credential resolver is required");
      }
      return createPiCodingAgentProvider({
        homePath: options.homePath ?? defaultMatrixHome(),
        ...options.pi,
      });
    }
    if (agent === "opencode") {
      if (!options.opencode?.resolveCredentialLaunch) {
        throw new Error("OpenCode credential resolver is required");
      }
      return createOpenCodeCodingAgentProvider({
        homePath: options.homePath ?? defaultMatrixHome(),
        ...options.opencode,
      });
    }
    return createWorkspaceCodingAgentProvider({
    providerId: agent,
    agent,
    runtime: options.runtime,
    runnable: agent === "codex" || agent === "claude",
    codexEvents: agent === "codex" ? options.codexEvents : undefined,
    codexControl: agent === "codex" ? options.codexControl : undefined,
    sharedBrowserEnabled: agent === "codex" && options.sharedBrowserEnabled,
    codexAdmission: agent === "codex" ? options.codexAdmission : undefined,
    backgroundRuntime: agent === "codex" ? options.backgroundRuntime : undefined,
    });
  });
  return {
    registryProviders,
    executionProviders: registryProviders,
    approvalsEnabled: agents.includes("codex") && Boolean(options.codexControl),
  };
}
