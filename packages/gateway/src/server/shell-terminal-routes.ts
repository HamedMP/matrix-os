/** Register shell, system activity and terminal workspace routes after auth. */
import type { Context, Hono } from "hono";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { readPreviewTerminalOwner } from "../auth.js";
import { createChatTerminalSessionService } from "../chat/terminal-session-service.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { ChatRepository } from "../chat/repository.js";
import type { GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import { createRateLimiter } from "../security/rate-limiter.js";
import { requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import {
  createShellCommandRunner, createShellRoutes, createTerminalAcceptanceRoutes,
  createTerminalWindowLayoutRoutes, createTerminalWorkspaceRoutes,
  createTerminalWorkspaceProjectAdmission, SHELL_SESSION_CREATE_RATE_LIMIT,
  type ShellPreferencesStore, type TerminalWindowLayoutStore,
} from "../shell/index.js";
import { CleanupCandidateRegistry, executeCleanupAction } from "../system-activity/cleanup.js";
import { collectSystemActivity } from "../system-activity/collector.js";
import { ActivityHistoryStore, AutoCleanupPolicyStore } from "../system-activity/history.js";
import { createSystemActivityRoutes } from "../system-activity/routes.js";

export interface ShellTerminalRouteOptions {
  app: Hono;
  homePath: string;
  terminalWorkspaceRuntime: TerminalRuntimeSocketClient;
  terminalRuntimeOwnerIds: string[];
  terminalWindowLayoutStore: TerminalWindowLayoutStore;
  shellPreferencesStore: ShellPreferencesStore;
  chatRepository: ChatRepository | null;
  canonicalChatExecutionRoots: ChatExecutionRootResolver | null;
  gatewayCollaboration: GatewayCollaborationRuntime | null;
}

export function registerShellTerminalRoutes(options: ShellTerminalRouteOptions) {
  const { app, homePath, terminalWorkspaceRuntime, terminalRuntimeOwnerIds,
    terminalWindowLayoutStore, shellPreferencesStore, chatRepository,
    canonicalChatExecutionRoots, gatewayCollaboration } = options;
  const shellSessionCreateRateLimiter = createRateLimiter(SHELL_SESSION_CREATE_RATE_LIMIT);
  const shellCommandRunner = createShellCommandRunner({ homePath });
  const retiredShellRegistry = {
    list: () => terminalWorkspaceRuntime.listWorkspaces(),
    create: async () => { throw new Error("Legacy terminal sessions are retired"); },
    delete: async () => { throw new Error("Legacy terminal sessions are retired"); },
  };
  const chatBoundShellRouteDeps = chatRepository
    ? {
        getPrincipal: (c: Context) => requireRequestPrincipal(c),
        listChatBoundSessionIds: (principal: RequestPrincipal, sessionIds: readonly string[]) =>
          chatRepository!.listBoundTerminalSessionIds(
            { type: "personal", ownerId: principal.userId },
            sessionIds,
          ),
      }
    : {};
  const chatBoundWorkspaceRouteDeps = chatRepository
    ? {
        listChatBoundSessionIds: (ownerScope: { type: "user" | "org"; id: string }, sessionIds: readonly string[]) =>
          chatRepository!.listBoundTerminalSessionIds(
            ownerScope.type === "org"
              ? { type: "organization", ownerId: ownerScope.id }
              : { type: "personal", ownerId: ownerScope.id },
            sessionIds,
          ),
      }
    : {};
  const shellRouteDeps = {
    homePath,
    registry: retiredShellRegistry,
    preferences: shellPreferencesStore,
    shellBackend: {
      health: async () => {
        try {
          await terminalWorkspaceRuntime.listWorkspaces();
          return { ok: true as const, code: "ok" as const };
        } catch (error) {
          console.error(
            "[gateway] terminal runtime health check failed",
            error instanceof Error ? error.name : "unknown_error",
          );
          return { ok: false as const, code: "zellij_failed" as const };
        }
      },
    },
    commandRunner: shellCommandRunner,
    sessionCreateRateLimiter: shellSessionCreateRateLimiter,
    sessionLifecycle: terminalWindowLayoutStore,
    chatTerminals: {
      prepare: async (principal: RequestPrincipal, chatId: string) => {
        if (!chatRepository || !canonicalChatExecutionRoots) {
          throw new Error("Chat terminal dependencies are unavailable");
        }
        return createChatTerminalSessionService({
          homePath,
          repository: chatRepository,
          executionRoots: canonicalChatExecutionRoots,
        }).prepare(principal, chatId);
      },
      bind: async (principal: RequestPrincipal, input: {
        chatId: string;
        runId?: string;
        sessionId: string;
        sessionCreatedAt: string;
      }) => {
        if (!chatRepository || !canonicalChatExecutionRoots) {
          throw new Error("Chat terminal dependencies are unavailable");
        }
        return createChatTerminalSessionService({
          homePath,
          repository: chatRepository,
          executionRoots: canonicalChatExecutionRoots,
        }).bind(principal, input);
      },
      authorizePaneAction: async (principal: RequestPrincipal, input: {
        chatId: string;
        sessionId: string;
        sessionCreatedAt: string;
      }) => {
        if (!chatRepository) return false;
        const binding = await chatRepository.getTerminalBinding(
          { type: "personal", ownerId: principal.userId },
          input.chatId,
          input.sessionId,
        );
        return binding?.sessionCreatedAt === input.sessionCreatedAt;
      },
      listBoundSessionIds: (principal: RequestPrincipal, sessionIds: readonly string[]) => {
        if (!chatRepository) return Promise.resolve([]);
        return chatRepository.listBoundTerminalSessionIds(
          { type: "personal", ownerId: principal.userId },
          sessionIds,
        );
      },
    },
    ...chatBoundShellRouteDeps,
  };
  const systemActivityCandidates = new CleanupCandidateRegistry();
  const systemActivityHistory = new ActivityHistoryStore({ homePath });
  const systemActivityPolicy = new AutoCleanupPolicyStore({ homePath });
  app.route("/api/system", createSystemActivityRoutes({
    collect: async (collectOptions) => {
      const policy = await systemActivityPolicy.read();
      return collectSystemActivity({
        homePath,
        collectOptions,
        candidates: systemActivityCandidates,
        cleanupGracePeriodSeconds: policy.gracePeriodSeconds,
      });
    },
    executeAction: (action) => executeCleanupAction({
      action,
      registry: systemActivityCandidates,
      history: systemActivityHistory,
    }),
    readPolicy: () => systemActivityPolicy.read(),
    savePolicy: (policy) => systemActivityPolicy.save(policy),
    readHistory: (query) => systemActivityHistory.list(query),
  }));
  const terminalWorkspaceProjectAdmission = createTerminalWorkspaceProjectAdmission({
    runtime: terminalWorkspaceRuntime,
    ...(gatewayCollaboration ? {
      projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
    } : {}),
  });
  app.route("/api/terminal", createTerminalWorkspaceRoutes({
    runtime: terminalWorkspaceRuntime,
    homePath,
    getPrincipal: (c) => requireRequestPrincipal(c),
    getPreviewTerminalOwner: readPreviewTerminalOwner,
    terminalOwnerIds: terminalRuntimeOwnerIds,
    chatTerminals: shellRouteDeps.chatTerminals,
    ...(gatewayCollaboration ? {
      projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
    } : {}),
  }));
  app.route("/api/terminal", createShellRoutes(shellRouteDeps));
  app.route(
    "/api/terminal/window-layouts",
    createTerminalWindowLayoutRoutes({ store: terminalWindowLayoutStore }),
  );
  const runtimeHandle = process.env.MATRIX_HANDLE ?? "";
  const terminalAcceptanceEnabled = /^pr-[1-9][0-9]{0,9}$/.test(runtimeHandle)
    && process.env.MATRIX_RUNTIME_SLOT === runtimeHandle;
  if (terminalAcceptanceEnabled) {
    app.route("/api/internal/terminal-acceptance", createTerminalAcceptanceRoutes({
      secret: () => process.env.UPGRADE_TOKEN ?? "",
      run: (input) => shellCommandRunner.run(input),
    }));
  }
  return { shellRouteDeps, terminalWorkspaceProjectAdmission,
    chatBoundWorkspaceRouteDeps, systemActivityCandidates };
}
