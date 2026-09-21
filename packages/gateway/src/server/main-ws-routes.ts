/** Register the authenticated main shell WebSocket and its bounded replay lifecycle. */
import { randomUUID } from "node:crypto";
import { type Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import { type ApprovalPolicy } from "@matrix-os/kernel";
import { type Dispatcher } from "../dispatcher.js";
import { type ConversationStore } from "../conversations.js";
import { createConversationLifecycle, providerResumeSessionId } from "../conversation-lifecycle.js";
import { createConversationContextResolver } from "../conversation-context.js";
import { ConversationRunRegistry, type ConversationRunMessage } from "../conversation-run-registry.js";
import { conversationHistoryRefreshRequired } from "../conversation-run-registry.js";
import { stampApprovalRequestForReplay } from "../conversation-approval-replay.js";
import { buildDispatchFailureReplayMessage } from "../conversation-dispatch-failure.js";
import {
  clearReconnectAbortTimersForSession as clearReconnectAbortTimers,
  replaceReconnectableAbortEntry,
  scheduleReconnectAbortTimersForDisconnectedClient,
  type ReconnectableAbortEntry,
} from "../conversation-reconnect-aborts.js";
import { isRequestPrincipalError, ownerScopeFromPrincipal, requireRequestPrincipal } from "../request-principal.js";
import { createApprovalBridge, type ApprovalBridge } from "../approval.js";
import { resolveSyncScope, syncScopeRegistryKey } from "../sync/runtime-scope.js";
import { createSyncPeerLifecycle } from "../sync/ws-peer-lifecycle.js";
import { initializeSyncInfrastructure } from "../sync/infrastructure.js";
import { MainWsClientMessageSchema, type MainWsClientMessage } from "../ws-message-schema.js";
import type { GatewayConfig, ServerMessage } from "./types.js";
import { kernelEventToServerMessage, kernelResultFallbackText, send, sendClientAck } from "./main-ws-messages.js";
import { wsConnectionsActive } from "../metrics.js";

const CONVERSATION_REPLAY_BATCH_SIZE = 100;
const CONVERSATION_RECONNECT_GRACE_MS = 30_000;
const MAX_RECONNECTABLE_ABORT_CONTROLLERS = 100;
const CLIENT_KERNEL_ERROR_MESSAGE = "Request failed";

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
type SyncPeerRegistry = Awaited<ReturnType<typeof initializeSyncInfrastructure>>["syncPeerRegistry"];

export interface MainWebSocketRouteOptions {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  syncReport: GatewayConfig["syncReport"];
  isSyncReportSent(): boolean;
  markSyncReportSent(): void;
  syncPeerRegistry: SyncPeerRegistry;
  conversationRuns: ConversationRunRegistry;
  conversationLifecycle: ReturnType<typeof createConversationLifecycle>;
  conversationContextResolver: ReturnType<typeof createConversationContextResolver>;
  reconnectableAbortControllers: Map<string, ReconnectableAbortEntry>;
  clients: Set<WSContext>;
  clientOwnerIds: WeakMap<WSContext, string>;
  conversations: ConversationStore;
  dispatcher: Dispatcher;
  approvalPolicy: ApprovalPolicy;
  captureGatewayProductEvent(event: string, properties?: Record<string, string | number | boolean | undefined>): void;
  evictOldestMainWsClientIfNeeded(): void;
  finalizeWithSummary(sessionId: string): Promise<void>;
  logUnexpectedJsonParseFailure(context: string, error: unknown): void;
}

export function registerMainWebSocketRoutes(options: MainWebSocketRouteOptions): void {
  const {
    app, upgradeWebSocket, syncReport, isSyncReportSent, markSyncReportSent,
    syncPeerRegistry, conversationRuns, conversationLifecycle, conversationContextResolver,
    reconnectableAbortControllers, clients, clientOwnerIds, conversations, dispatcher,
    approvalPolicy, captureGatewayProductEvent, evictOldestMainWsClientIfNeeded,
    finalizeWithSummary, logUnexpectedJsonParseFailure,
  } = options;
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // Capture the authenticated sync userId at upgrade time so the
      // sync:subscribe branch below keys peers off the same principal as the
      // HTTP sync routes. authMiddleware ran on the upgrade request and
      // stashed claims if a JWT was presented.
      let syncPeerLifecycle = null;
      let syncPeerSocket: WSContext | null = null;
      let conversationOwnerScope: ReturnType<typeof ownerScopeFromPrincipal> | undefined;
      let connectionOwnerId: string | undefined;
      try {
        const wsPrincipal = requireRequestPrincipal(c);
        const wsScope = resolveSyncScope({
          ownerId: wsPrincipal.userId,
          runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
        });
        const wsSyncScopeKey = syncScopeRegistryKey(wsScope);
        connectionOwnerId = wsPrincipal.userId;
        conversationOwnerScope = ownerScopeFromPrincipal(wsPrincipal);
        syncPeerLifecycle = syncPeerRegistry
          ? createSyncPeerLifecycle(syncPeerRegistry, wsSyncScopeKey, {
              send: (data: string) => syncPeerSocket?.send(data),
              get readyState() {
                return syncPeerSocket?.readyState ?? 3;
              },
            })
          : null;
      } catch (err) {
        if (!isRequestPrincipalError(err)) {
          throw err;
        }
        console.warn("[sync/ws] Missing or invalid sync request principal on websocket upgrade");
      }
      let pendingText: string | undefined;
      let activeSessionId: string | undefined;
      let approvalBridge: ApprovalBridge | undefined;
      let detachConversationRun: (() => void) | null = null;
      let conversationReplayVersion = 0;
      // Per-WS-connection abort controllers, keyed by requestId. Created
      // when the user submits a message; consumed when they explicitly
      // stop the agent. Cleaned up after result / error / aborted so the
      // map doesn't grow.
      const abortControllers = new Map<string, AbortController>();

      const clearReconnectAbortTimersForSession = (sessionId: string | undefined) => {
        clearReconnectAbortTimers(reconnectableAbortControllers, sessionId);
      };

      const clearConversationRunAttachment = () => {
        conversationReplayVersion++;
        if (detachConversationRun) {
          detachConversationRun();
          detachConversationRun = null;
        }
      };

      const publishConversationRunMessage = (
        sessionId: string | undefined,
        message: ConversationRunMessage,
      ) => {
        if (!sessionId) {
          return;
        }
        conversationRuns.publish(sessionId, message);
      };

      const replayConversationRun = (
        ws: WSContext,
        bufferedMessages: ConversationRunMessage[],
        onComplete?: () => void,
      ) => {
        const replayVersion = conversationReplayVersion;
        if (bufferedMessages.length === 0) {
          onComplete?.();
          return;
        }

        const flushBatch = (startIndex: number) => {
          if (replayVersion !== conversationReplayVersion) {
            return;
          }

          const endIndex = Math.min(
            startIndex + CONVERSATION_REPLAY_BATCH_SIZE,
            bufferedMessages.length,
          );
          for (let index = startIndex; index < endIndex; index++) {
            send(ws, bufferedMessages[index] as ServerMessage);
          }
          if (endIndex < bufferedMessages.length) {
            setTimeout(() => flushBatch(endIndex), 0);
            return;
          }

          onComplete?.();
        };

        flushBatch(0);
      };

      return {
        onOpen(_evt, ws) {
          syncPeerSocket = ws;
          evictOldestMainWsClientIfNeeded();
          clients.add(ws);
          if (connectionOwnerId) clientOwnerIds.set(ws, connectionOwnerId);
          wsConnectionsActive.inc();
          captureGatewayProductEvent("shell_ws_open", {
            active_clients: clients.size,
          });
          approvalBridge = createApprovalBridge({
            send: (msg) => {
              const replayableMessage = stampApprovalRequestForReplay(activeSessionId, msg);
              send(ws, replayableMessage);
              publishConversationRunMessage(activeSessionId, replayableMessage);
            },
            timeout: approvalPolicy.timeout,
          });

          // T2093: Send sync report once per boot
          if (syncReport && !isSyncReportSent()) {
            markSyncReportSent();
            send(ws, {
              type: "os:sync-report",
              payload: syncReport,
            });
          }
        },

        onMessage(evt, ws) {
          let rawMessage: unknown;
          try {
            rawMessage = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            );
          } catch (err: unknown) {
            logUnexpectedJsonParseFailure("Failed to parse main WebSocket message", err);
            send(ws, { type: "kernel:error", message: "Invalid JSON" });
            return;
          }

          const parsedResult = MainWsClientMessageSchema.safeParse(rawMessage);
          if (!parsedResult.success) {
            captureGatewayProductEvent("shell_ws_invalid_message");
            send(ws, { type: "kernel:error", message: "Invalid message format" });
            return;
          }

          const parsed: MainWsClientMessage = parsedResult.data;

          if (parsed.type === "ping") {
            send(ws, { type: "pong" } as ServerMessage);
            return;
          }

          if (parsed.type === "switch_session") {
            activeSessionId = parsed.sessionId;
            clearConversationRunAttachment();
            clearReconnectAbortTimersForSession(parsed.sessionId);
            sendClientAck(ws, parsed, "accepted", false);
            const pendingLiveMessages: ConversationRunMessage[] = [];
            let replayComplete = false;
            const attachment = conversationRuns.attachWithBufferedSnapshot(
              parsed.sessionId,
              (message) => {
                if (!replayComplete) {
                  pendingLiveMessages.push(message);
                  return;
                }
                send(ws, message as ServerMessage);
              },
              { replayCompleted: parsed.replayCompleted },
            );
            if (attachment) {
              detachConversationRun = attachment.detach;
              replayConversationRun(ws, attachment.bufferedMessages, () => {
                replayComplete = true;
                send(ws, {
                  type: "session:switched",
                  sessionId: parsed.sessionId,
                  historyRefreshRequired: conversationHistoryRefreshRequired(
                    attachment,
                    parsed.replayCompleted,
                  ),
                });
                for (const message of pendingLiveMessages) {
                  send(ws, message as ServerMessage);
                }
                pendingLiveMessages.length = 0;
              });
              return;
            }

            send(ws, {
              type: "session:switched",
              sessionId: parsed.sessionId,
              historyRefreshRequired: true,
            });
            return;
          }

          if (parsed.type === "approval_response") {
            if (approvalBridge) {
              approvalBridge.handleResponse({ id: parsed.id, approved: parsed.approved });
              sendClientAck(ws, parsed, "accepted", false);
            } else {
              sendClientAck(ws, parsed, "rejected", true);
            }
            return;
          }

          if (parsed.type === "sync:subscribe" && syncPeerRegistry) {
            captureGatewayProductEvent("sync_peer_subscribe", {
              shell_surface: "gateway_ws",
              client_version_present: Boolean(parsed.clientVersion),
            });
            syncPeerLifecycle?.subscribe({
              peerId: parsed.peerId,
              hostname: parsed.hostname,
              platform: parsed.platform,
              clientVersion: parsed.clientVersion,
            });
            return;
          }

          if (parsed.type === "abort") {
            const controller = abortControllers.get(parsed.requestId)
              ?? reconnectableAbortControllers.get(parsed.requestId)?.controller;
            if (controller) {
              controller.abort();
              sendClientAck(ws, parsed, "accepted", false);
              // Map cleanup happens in the dispatcher's terminal-event
              // path (kernel:aborted -> delete). No need to delete here.
            } else {
              sendClientAck(ws, parsed, "rejected", false);
            }
            return;
          }

          if (parsed.type === "message") {
            const requestedSessionId = parsed.sessionId;
            let admittedExistingConversation = false;
            void (async () => {
              const admittedSessionId = requestedSessionId;
              let canonicalAdmittedSessionId = admittedSessionId;
              let dispatchSessionId = admittedSessionId;
              let workingDirectory: string | undefined;
              if (admittedSessionId) {
                const admission = await conversationLifecycle.admitExistingPrepared(
                  admittedSessionId,
                  async (conversation) => {
                    const resumeSessionId = providerResumeSessionId(conversation);
                    if (!conversation.context) {
                      return { workingDirectory: undefined, resumeSessionId };
                    }
                    const resolvedContext = await conversationContextResolver.resolve(
                      conversation.context.projectId,
                      conversationOwnerScope,
                    );
                    return resolvedContext
                      ? { workingDirectory: resolvedContext.workingDirectory, resumeSessionId }
                      : null;
                  },
                );
                if (admission.status !== "admitted") {
                  sendClientAck(ws, parsed, "rejected", admission.status === "busy");
                  send(ws, {
                    type: "kernel:error",
                    message: admission.status === "busy"
                      ? "Conversation already has an active turn."
                      : admission.status === "unavailable"
                        ? "conversation_context_unavailable"
                        : "Conversation is unavailable. Refresh and try again.",
                  });
                  return;
                }
                admittedExistingConversation = true;
                workingDirectory = admission.prepared.workingDirectory;
                dispatchSessionId = admission.prepared.resumeSessionId;
                activeSessionId = admittedSessionId;
              } else {
                activeSessionId = undefined;
              }

              clearConversationRunAttachment();
              pendingText = parsed.displayText ?? parsed.text;
              const requestId = parsed.requestId;
              let lastToolName: string | undefined;
              let receivedAssistantText = false;
              captureGatewayProductEvent("agent_task_started", {
                shell_surface: "gateway_ws",
                request_id_present: Boolean(requestId),
                session_id_present: Boolean(parsed.sessionId),
              });

            // Register abort controller so the user can stop this run.
            // Skip if no requestId (legacy clients) -- they can't target
            // a specific run anyway.
              const abortController = requestId ? new AbortController() : undefined;
              if (requestId && abortController) {
                abortControllers.set(requestId, abortController);
                replaceReconnectableAbortEntry(reconnectableAbortControllers, requestId, {
                  controller: abortController,
                  sessionId: parsed.sessionId,
                  abortTimer: null,
                }, {
                  maxEntries: MAX_RECONNECTABLE_ABORT_CONTROLLERS,
                });
              }
              sendClientAck(ws, parsed, "accepted", false);
              let runEventSeq = 0;
              const replayRequestId = requestId ?? `legacy-${randomUUID()}`;
              const withReplayId = (msg: ServerMessage): ServerMessage => {
                if (!msg.type.startsWith("kernel:")) return msg;
                const replaySessionId = msg.type === "kernel:init"
                  ? msg.sessionId
                  : activeSessionId ?? parsed.sessionId ?? "pending";
                return {
                  ...msg,
                  eventId: `${replaySessionId}:${replayRequestId}:${runEventSeq++}`,
                } as ServerMessage;
              };

              dispatcher
              .dispatch(parsed.text, dispatchSessionId, async (event) => {
                  const msg = withReplayId(kernelEventToServerMessage(event, requestId));

                  if (msg.type === "kernel:init") {
                    if (
                      canonicalAdmittedSessionId
                      && canonicalAdmittedSessionId !== msg.sessionId
                    ) {
                      const adoption = await conversationLifecycle.adoptProviderSession(
                        canonicalAdmittedSessionId,
                        msg.sessionId,
                      );
                      if (adoption !== "adopted") {
                        throw new Error("Conversation could not adopt provider session");
                      }
                      canonicalAdmittedSessionId = msg.sessionId;
                    }
                    activeSessionId = msg.sessionId;
                    if (requestId) {
                      const reconnectable = reconnectableAbortControllers.get(requestId);
                      if (reconnectable) reconnectable.sessionId = msg.sessionId;
                    }
                    if (!canonicalAdmittedSessionId || canonicalAdmittedSessionId !== msg.sessionId) {
                      conversations.begin(msg.sessionId);
                      conversationRuns.begin(
                        msg.sessionId,
                        conversations.get(msg.sessionId)?.messages.length ?? 0,
                      );
                    }
                    send(ws, msg);
                    publishConversationRunMessage(msg.sessionId, msg);
                    if (pendingText) {
                      conversations.addUserMessage(msg.sessionId, pendingText);
                      pendingText = undefined;
                    }
                  } else {
                    send(ws, msg);
                  }
                  if (msg.type === "kernel:text" && activeSessionId) {
                    receivedAssistantText = true;
                    publishConversationRunMessage(activeSessionId, msg);
                    conversations.appendAssistantText(activeSessionId, msg.text);
                  } else if (msg.type === "kernel:tool_start" && activeSessionId) {
                    publishConversationRunMessage(activeSessionId, msg);
                    lastToolName = msg.tool;
                    conversations.addToolStart(activeSessionId, msg.tool);
                  } else if (msg.type === "kernel:tool_end" && activeSessionId) {
                    publishConversationRunMessage(activeSessionId, msg);
                    conversations.addToolEnd(activeSessionId, lastToolName ?? "unknown", msg.input);
                  } else if (msg.type === "kernel:result" && activeSessionId) {
                    const fallbackText = kernelResultFallbackText(event, receivedAssistantText);
                    if (fallbackText) conversations.appendAssistantText(activeSessionId, fallbackText);
                    captureGatewayProductEvent("agent_task_completed", {
                      shell_surface: "gateway_ws",
                      request_id_present: Boolean(requestId),
                    });
                    publishConversationRunMessage(activeSessionId, msg);
                    void finalizeWithSummary(activeSessionId);
                  } else if (msg.type === "kernel:error" && activeSessionId) {
                    captureGatewayProductEvent("agent_task_failed", {
                      shell_surface: "gateway_ws",
                      request_id_present: Boolean(requestId),
                    });
                    publishConversationRunMessage(activeSessionId, {
                      ...msg,
                      message: CLIENT_KERNEL_ERROR_MESSAGE,
                    });
                    conversations.addSystemMessage(activeSessionId, CLIENT_KERNEL_ERROR_MESSAGE);
                    void finalizeWithSummary(activeSessionId);
                  } else if (msg.type === "kernel:aborted" && activeSessionId) {
                    publishConversationRunMessage(activeSessionId, msg);
                    conversations.addSystemMessage(activeSessionId, "Stopped.");
                    void finalizeWithSummary(activeSessionId);
                  }
              }, undefined, abortController, {
                model: parsed.model,
                effort: parsed.effort,
                accessSourceId: parsed.accessSourceId,
                workingDirectory,
                requestApproval: approvalBridge?.requestApproval,
              })
              .catch((err: Error) => {
                console.error("[gateway] Conversation dispatch failed:", err);
                captureGatewayProductEvent("agent_task_dispatch_failed", {
                  shell_surface: "gateway_ws",
                  request_id_present: Boolean(requestId),
                });
                const failureReplay = buildDispatchFailureReplayMessage({
                  activeSessionId,
                  requestId,
                  clientMessage: CLIENT_KERNEL_ERROR_MESSAGE,
                  stamp: (message) => withReplayId(message) as typeof message,
                });
                if (activeSessionId && failureReplay.runMessage) {
                  publishConversationRunMessage(
                    activeSessionId,
                    failureReplay.runMessage as ConversationRunMessage,
                  );
                  conversations.addSystemMessage(activeSessionId, CLIENT_KERNEL_ERROR_MESSAGE);
                  void finalizeWithSummary(activeSessionId);
                }
                send(ws, failureReplay.liveMessage);
              })
              .finally(() => {
                if (requestId) {
                  abortControllers.delete(requestId);
                  const reconnectable = reconnectableAbortControllers.get(requestId);
                  if (reconnectable?.abortTimer) clearTimeout(reconnectable.abortTimer);
                  reconnectableAbortControllers.delete(requestId);
                }
                });
            })().catch((error: unknown) => {
              console.error("[gateway] Conversation admission failed:", error);
              if (admittedExistingConversation && requestedSessionId) {
                void finalizeWithSummary(requestedSessionId);
              }
              sendClientAck(ws, parsed, "rejected", true);
              send(ws, { type: "kernel:error", message: CLIENT_KERNEL_ERROR_MESSAGE });
            });
          }
        },

        onClose(_evt, ws) {
          clearConversationRunAttachment();
          syncPeerLifecycle?.close();
          syncPeerSocket = null;
          // Abort inactive in-flight runs so the kernel doesn't keep burning
          // tokens forever, while still allowing short browser reconnects to
          // replay and reattach runs that still have an active subscriber.
          scheduleReconnectAbortTimersForDisconnectedClient(
            reconnectableAbortControllers,
            {
              graceMs: CONVERSATION_RECONNECT_GRACE_MS,
              hasActiveSessionConnection: (sessionId) =>
                conversationRuns.hasActiveSubscribers(sessionId),
            },
          );
          abortControllers.clear();
          if (clients.delete(ws)) {
            wsConnectionsActive.dec();
          }
          captureGatewayProductEvent("shell_ws_close", {
            active_clients: clients.size,
          });
        },
      };
    }),
  );

}
