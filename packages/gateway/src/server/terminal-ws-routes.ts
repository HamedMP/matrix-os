import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v4";
import { TerminalRuntimeSocketClient, TerminalFrameQueue } from "@matrix-os/terminal-runtime";
import { CanonicalChatIdSchema, TerminalRefSchema, TerminalTabClientFrameSchema } from "@matrix-os/contracts";
import { readPreviewTerminalOwner } from "../auth.js";
import type { ChatRepository } from "../chat/repository.js";
import { hasActiveWorkspaceSessionForTerminalRef } from "../agent-session-manager.js";
import { resolveTerminalAttachmentMode, terminalAttachmentAllowsFrame, createSessionRuntimeBridge } from "../session-runtime-bridge.js";
import { parseTerminalInputCapabilityRequest, terminalFrameForInputCapabilities } from "../terminal-input-capabilities.js";
import { createTerminalSizeLease } from "../terminal-size-lease.js";
import { createTerminalLiveOwnership } from "../terminal-live-ownership.js";
import { createTerminalWorkspaceProjectAdmission, terminalResourceOwnerId, terminalRuntimeRefAccess, shellWsMessageDataToString } from "../shell/index.js";
import type { RequestPrincipal } from "../request-principal.js";

interface TerminalWebSocketRouteOptions {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  homePath: string;
  terminalWorkspaceRuntime: TerminalRuntimeSocketClient;
  terminalLiveOwnership: ReturnType<typeof createTerminalLiveOwnership>;
  workspaceSessionRuntimeBridge: ReturnType<typeof createSessionRuntimeBridge>;
  terminalRuntimeOwnerIds: readonly string[];
  chatRepository: ChatRepository | null;
  terminalWorkspaceProjectAdmission: ReturnType<typeof createTerminalWorkspaceProjectAdmission>;
  captureTerminalEvent(event: string, properties?: Record<string, string | number | boolean | undefined>): void;
  getPrincipal(context: Context): RequestPrincipal;
  logBestEffortFailure(context: string, error: unknown): void;
  logUnexpectedJsonParseFailure(context: string, error: unknown): void;
  logUnexpectedWsSendFailure(context: string, error: unknown): void;
}

/** Register the workspace/tab socket and explicit upgrade responses for retired terminal sockets. */
export function registerTerminalWebSocketRoutes(options: TerminalWebSocketRouteOptions): void {
  const {
    app, upgradeWebSocket, homePath, terminalWorkspaceRuntime, terminalLiveOwnership,
    workspaceSessionRuntimeBridge, terminalRuntimeOwnerIds, chatRepository,
    terminalWorkspaceProjectAdmission, captureTerminalEvent, getPrincipal,
    logBestEffortFailure, logUnexpectedJsonParseFailure, logUnexpectedWsSendFailure,
  } = options;
  app.get(
    "/ws/terminal/tab",
    upgradeWebSocket((c) => {
      const refResult = TerminalRefSchema.safeParse({
        workspaceId: c.req.query("workspaceId"),
        tabId: c.req.query("tabId"),
      });
      // CLIs released before the `cli` sizing fix declare a sized TTY as `client=hard`.
      const clientResult = z.enum(["browser", "canvas", "desktop", "electron", "mobile", "cli", "hard"])
        .transform((client) => client === "hard" ? "cli" as const : client)
        .safeParse(c.req.query("client"));
      const chatResult = c.req.query("chat") === undefined
        ? { success: true as const, data: undefined }
        : CanonicalChatIdSchema.safeParse(c.req.query("chat"));
      const attachmentTokenResult = c.req.query("attachmentToken") === undefined
        ? { success: true as const, data: undefined }
        : z.string().length(48).regex(/^[a-f0-9]+$/).safeParse(c.req.query("attachmentToken"));
      const leaseResult = c.req.query("lease") === undefined
        ? { success: true as const, data: undefined }
        : z.enum(["exclusive", "observe"]).safeParse(c.req.query("lease"));
      const fromSeqRaw = c.req.query("fromSeq") ?? "0";
      const colsRaw = c.req.query("cols") ?? "120";
      const rowsRaw = c.req.query("rows") ?? "36";
      const fromSeq = /^\d+$/.test(fromSeqRaw) ? Number(fromSeqRaw) : Number.NaN;
      const cols = /^\d+$/.test(colsRaw) ? Number(colsRaw) : Number.NaN;
      const rows = /^\d+$/.test(rowsRaw) ? Number(rowsRaw) : Number.NaN;
      const binaryInputRequested = parseTerminalInputCapabilityRequest(c.req.query("inputCapability"));
      const validNumbers = Number.isSafeInteger(fromSeq) && fromSeq >= 0
        && Number.isSafeInteger(cols) && cols >= 20 && cols <= 500
        && Number.isSafeInteger(rows) && rows >= 5 && rows <= 200;
      let stream: ReturnType<TerminalRuntimeSocketClient["attach"]> | null = null;
      let attachmentMode: "owner" | "observe" | null = null;
      let ownershipKey: string | null = null;
      const ownershipViewerId = randomUUID();
      let principal: RequestPrincipal | null = null;
      let closed = false;
      let inputQueue: TerminalFrameQueue | null = null;

      return {
        onOpen(_event, ws) {
          inputQueue = new TerminalFrameQueue({
            onOverflow: () => {
              captureTerminalEvent("input-overflow", { client: clientResult.success ? clientResult.data : undefined });
              closed = true;
              ws.close(1013, "Terminal input queue full");
            },
            onError: (error) => {
              logBestEffortFailure("Terminal tab mutation authorization failed", error);
              if (!closed) {
                try {
                  ws.send(JSON.stringify({
                    type: "error",
                    code: "authorization_failed",
                    message: "Terminal operation unavailable",
                  }));
                } catch (sendError: unknown) {
                  logUnexpectedWsSendFailure("Terminal tab WebSocket error send failed", sendError);
                }
                closed = true;
                ws.close();
              }
            },
          });
          if (!refResult.success || !clientResult.success || !chatResult.success
            || !attachmentTokenResult.success || !leaseResult.success || !validNumbers) {
            ws.send(JSON.stringify({ type: "error", code: "invalid_request", message: "Invalid request" }));
            ws.close();
            return;
          }
          void (async () => {
            principal = getPrincipal(c);
            const resourceOwnerId = terminalResourceOwnerId(principal, readPreviewTerminalOwner(c));
            const refAccess = await terminalRuntimeRefAccess(
              principal,
              terminalRuntimeOwnerIds,
              terminalWorkspaceRuntime,
              refResult.data,
              readPreviewTerminalOwner(c),
            );
            if (refAccess === "not_found" || refAccess === "unavailable") {
              throw new Error("Terminal runtime reference denied");
            }
            const actorOwner = { type: "personal" as const, ownerId: principal.userId };
            const refKey = `${refResult.data.workspaceId}:${refResult.data.tabId}`;
            const terminalAuthorizationRepository = chatRepository;
            if (chatResult.data) {
              if (!terminalAuthorizationRepository) throw new Error("Terminal attachment authorization unavailable");
              const binding = await terminalAuthorizationRepository.getTerminalBinding(actorOwner, chatResult.data, refKey);
              if (!binding) throw new Error("Chat terminal attachment denied");
            } else {
              if (refAccess === "chat_required") throw new Error("Chat terminal attachment requires Chat context");
              if (refAccess === "repository_required" && !terminalAuthorizationRepository) {
                throw new Error("Terminal attachment authorization unavailable");
              }
              if (terminalAuthorizationRepository) {
                const bound = await terminalAuthorizationRepository.listBoundTerminalSessionIds(
                  { type: "personal", ownerId: resourceOwnerId },
                  [refKey],
                );
                if (bound.includes(refKey)) throw new Error("Chat terminal attachment requires Chat context");
              }
            }
            attachmentMode = await resolveTerminalAttachmentMode({
              ...(attachmentTokenResult.data
                ? { attachmentToken: attachmentTokenResult.data }
                : {}),
              ownerId: resourceOwnerId,
              terminalRef: refResult.data,
            }, {
              consumeSessionAttachment: workspaceSessionRuntimeBridge.consumeSessionAttachment,
              requiresAttachmentToken: (ref) => hasActiveWorkspaceSessionForTerminalRef(homePath, ref),
            });
            const sizeLease = createTerminalSizeLease(refResult.data, (frame) => { stream?.send(frame); });
            ownershipKey = `${principal.userId}:${refKey}`;
            terminalLiveOwnership.attach({
              key: ownershipKey,
              viewerId: ownershipViewerId,
              exclusive: leaseResult.data === "exclusive",
              observe: leaseResult.data === "observe",
              onRevoked: (epoch) => {
                if (closed) return;
                try {
                  sizeLease.revoke();
                  ws.send(JSON.stringify({
                    type: "lease-revoked",
                    terminalRef: refResult.data,
                    epoch,
                  }));
                } catch (error: unknown) {
                  logUnexpectedWsSendFailure("Terminal ownership revocation send failed", error);
                }
              },
            });
            if (closed) {
              terminalLiveOwnership.detach(ownershipKey, ownershipViewerId);
              ownershipKey = null;
              return;
            }
            const mode = clientResult.data === "cli"
              && attachmentMode === "owner"
              && terminalLiveOwnership.role(ownershipKey, ownershipViewerId) === "writer"
              ? "hard" as const
              : "soft" as const;
            captureTerminalEvent("attach-request", { client: clientResult.data, mode });
            stream = await terminalWorkspaceProjectAdmission.withWorkspace(
              resourceOwnerId,
              refResult.data.workspaceId,
              "run",
              async () => terminalWorkspaceRuntime.attach({
                ref: refResult.data,
                viewerId: `${clientResult.data}:${randomUUID()}`,
                fromSeq,
                mode,
                size: { cols, rows },
                onFrame: (frame) => {
                  if (closed) return;
                  try {
                    const capableFrame = terminalFrameForInputCapabilities(frame, binaryInputRequested);
                    if (capableFrame.type === "attached" && ownershipKey) {
                      const role = terminalLiveOwnership.role(ownershipKey, ownershipViewerId);
                      const leaseEpoch = terminalLiveOwnership.leaseEpoch(ownershipKey, ownershipViewerId);
                      ws.send(JSON.stringify({
                        ...capableFrame,
                        ownership: role,
                        ...(leaseEpoch === null ? {} : { leaseEpoch }),
                      }));
                    } else {
                      ws.send(JSON.stringify(capableFrame));
                    }
                  }
                  catch (error) { logUnexpectedWsSendFailure("Terminal tab WebSocket send failed", error); }
                },
                onClose: () => { if (!closed) ws.close(); },
                onError: (error) => {
                  captureTerminalEvent("runtime-error", { client: clientResult.data });
                  logBestEffortFailure("Terminal tab runtime stream failed", error);
                  if (!closed) {
                    try { ws.send(JSON.stringify({ type: "error", code: "runtime_unavailable", message: "Terminal unavailable" })); }
                    catch (sendError) { logUnexpectedWsSendFailure("Terminal tab WebSocket error send failed", sendError); }
                    ws.close();
                  }
                },
              }),
            );
            if (closed) { stream.close(); stream = null; return; }
            sizeLease.attached();
            inputQueue?.resume(async (frame) => {
              if (closed || !stream || !principal) return;
              await terminalWorkspaceProjectAdmission.withWorkspace(
                resourceOwnerId,
                refResult.data.workspaceId,
                "run",
                async () => {
                  if (closed || !stream || !attachmentMode || !ownershipKey) return;
                  terminalLiveOwnership.touch(ownershipKey, ownershipViewerId);
                  if (terminalLiveOwnership.role(ownershipKey, ownershipViewerId) !== "writer") sizeLease.revoke();
                  const liveOwnershipAllowsFrame = frame.type === "scroll-query" || frame.type === "ping"
                    || frame.type === "detach"
                    || (frame.type === "resize" && frame.mode === "soft")
                    || terminalLiveOwnership.allowsMutation(ownershipKey, ownershipViewerId);
                  if (terminalAttachmentAllowsFrame(attachmentMode, frame) && liveOwnershipAllowsFrame) {
                    stream.send(frame);
                  } else {
                    ws.send(JSON.stringify({ type: "error", code: "read_only", message: "Terminal is read-only" }));
                  }
                },
              );
            });
          })().catch((error: unknown) => {
            logBestEffortFailure("Terminal tab authorization failed", error);
            if (!closed) {
              try { ws.send(JSON.stringify({ type: "error", code: "attach_failed", message: "Shell attach failed" })); }
              catch (sendError) { logUnexpectedWsSendFailure("Terminal tab WebSocket error send failed", sendError); }
              ws.close();
            }
          });
        },
        onMessage(event, ws) {
          const raw = shellWsMessageDataToString(event.data);
          if (raw === null) return;
          let frame: unknown;
          try { frame = JSON.parse(raw); }
          catch (error) {
            logUnexpectedJsonParseFailure("Failed to parse terminal tab WebSocket message", error);
            ws.close();
            return;
          }
          const parsed = TerminalTabClientFrameSchema.safeParse(frame);
          if (!parsed.success) {
            ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: "Invalid message" }));
            ws.close();
            return;
          }
          if (!closed) inputQueue?.enqueue(parsed.data);
        },
        onClose() {
          if (stream) captureTerminalEvent("close", { client: clientResult.success ? clientResult.data : undefined });
          closed = true;
          inputQueue?.close();
          inputQueue = null;
          if (ownershipKey) terminalLiveOwnership.detach(ownershipKey, ownershipViewerId);
          ownershipKey = null;
          stream?.close();
          stream = null;
        },
      };
    }),
  );

  const clientUpgradeRequired = (c: Context) => c.json({
    error: "client_upgrade_required",
    message: "Upgrade Matrix OS to use terminal workspaces.",
  }, 426);
  app.get("/ws/terminal/session", clientUpgradeRequired);
  app.get("/ws/terminal", clientUpgradeRequired);



}
