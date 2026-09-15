import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { WSEvents } from "hono/ws";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, TerminalRefSchema, TerminalTabClientFrameSchema } from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import type { ChatRepository } from "../chat/repository.js";
import { resolveTerminalAttachmentMode, terminalAttachmentAllowsFrame } from "../session-runtime-bridge.js";
import { parseTerminalInputCapabilityRequest, terminalFrameForInputCapabilities } from "../terminal-input-capabilities.js";
import { shellWsMessageDataToString } from "./ws.js";
import { terminalRuntimeRefAccess, terminalResourceOwnerId, type TerminalWorkspaceProjectAdmission } from "./workspace-routes.js";

type LogFailure = (context: string, error: unknown) => void;
interface TerminalTabWebSocketOptions {
  terminalOwnerIds: readonly string[];
  runtime: Pick<TerminalRuntimeSocketClient, "listWorkspaces" | "attach">;
  projectAdmission: TerminalWorkspaceProjectAdmission;
  chatRepository?: Pick<ChatRepository, "getTerminalBinding" | "listBoundTerminalSessionIds"> | null;
  attachmentDependencies: Parameters<typeof resolveTerminalAttachmentMode>[1];
  captureTerminalEvent: (event: string, properties?: Record<string, string | number | boolean | undefined>) => void;
  logBestEffortFailure?: LogFailure;
  logUnexpectedWsSendFailure?: LogFailure;
  logUnexpectedJsonParseFailure?: LogFailure;
}

/** The same handler is mounted by the gateway and exercised by routing integration tests. */
export function createTerminalTabWebSocketHandler(c: Context, options: TerminalTabWebSocketOptions): WSEvents {
  const { terminalOwnerIds, runtime, projectAdmission, chatRepository, attachmentDependencies,
    captureTerminalEvent, logBestEffortFailure = console.error, logUnexpectedWsSendFailure = console.error,
    logUnexpectedJsonParseFailure = console.error } = options;

  const refResult = TerminalRefSchema.safeParse({
    workspaceId: c.req.query("workspaceId"),
    tabId: c.req.query("tabId"),
  });
  const clientResult = z.enum(["browser", "canvas", "desktop", "electron", "mobile", "cli"])
    .safeParse(c.req.query("client"));
  const chatResult = c.req.query("chat") === undefined
    ? { success: true as const, data: undefined }
    : CanonicalChatIdSchema.safeParse(c.req.query("chat"));
  const attachmentTokenResult = c.req.query("attachmentToken") === undefined
    ? { success: true as const, data: undefined }
    : z.string().length(48).regex(/^[a-f0-9]+$/).safeParse(c.req.query("attachmentToken"));
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
  let principal: RequestPrincipal | null = null;
  let closed = false;
  const pending: unknown[] = [];
  let frameAdmissionTail = Promise.resolve();
  let pendingFrameAdmissions = 0;
  let sendAuthorizedFrame: ((frame: z.infer<typeof TerminalTabClientFrameSchema>) => void) | null = null;

  return {
    onOpen(_event, ws) {
      if (!refResult.success || !clientResult.success || !chatResult.success
        || !attachmentTokenResult.success || !validNumbers) {
        ws.send(JSON.stringify({ type: "error", code: "invalid_request", message: "Invalid request" }));
        ws.close();
        return;
      }
      void (async () => {
        principal = requireRequestPrincipal(c);
        const refAccess = await terminalRuntimeRefAccess(
          principal,
          terminalOwnerIds,
          runtime,
          refResult.data,
        );
        if (refAccess === "not_found" || refAccess === "unavailable") {
          throw new Error("Terminal runtime reference denied");
        }
        const owner = { type: "personal" as const, ownerId: principal.userId };
        const refKey = `${refResult.data.workspaceId}:${refResult.data.tabId}`;
        const terminalAuthorizationRepository = chatRepository;
        if (chatResult.data) {
          if (!terminalAuthorizationRepository) throw new Error("Terminal attachment authorization unavailable");
          const binding = await terminalAuthorizationRepository.getTerminalBinding(owner, chatResult.data, refKey);
          if (!binding) throw new Error("Chat terminal attachment denied");
        } else {
          if (refAccess === "chat_required") throw new Error("Chat terminal attachment requires Chat context");
          if (refAccess === "repository_required" && !terminalAuthorizationRepository) {
            throw new Error("Terminal attachment authorization unavailable");
          }
          if (terminalAuthorizationRepository) {
            const bound = await terminalAuthorizationRepository.listBoundTerminalSessionIds(
              { type: "personal", ownerId: terminalResourceOwnerId(principal) }, [refKey],
            );
            if (bound.includes(refKey)) throw new Error("Chat terminal attachment requires Chat context");
          }
        }
        attachmentMode = await resolveTerminalAttachmentMode({
          ...(attachmentTokenResult.data
            ? { attachmentToken: attachmentTokenResult.data }
            : {}),
          ownerId: terminalResourceOwnerId(principal),
          terminalRef: refResult.data,
        }, attachmentDependencies);
        if (closed) return;
        const mode = clientResult.data === "cli" ? "hard" as const : "soft" as const;
        captureTerminalEvent("attach-request", { client: clientResult.data, mode, actorId: principal.userId, ownerId: terminalResourceOwnerId(principal) });
        stream = await projectAdmission.withWorkspace(
          principal,
          refResult.data.workspaceId,
          "run",
          async () => runtime.attach({
            ref: refResult.data,
            viewerId: `${clientResult.data}:${randomUUID()}`,
            fromSeq,
            mode,
            size: { cols, rows },
            onFrame: (frame) => {
              if (closed) return;
              try {
                ws.send(JSON.stringify(terminalFrameForInputCapabilities(frame, binaryInputRequested)));
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
        sendAuthorizedFrame = (frame) => {
          if (pendingFrameAdmissions >= 32) {
            ws.close();
            return;
          }
          pendingFrameAdmissions += 1;
          frameAdmissionTail = frameAdmissionTail.then(async () => {
            if (closed || !stream || !principal) return;
            await projectAdmission.withWorkspace(
              principal,
              refResult.data.workspaceId,
              "run",
              async () => {
                if (!closed && stream) stream.send(frame);
              },
            );
          }).catch((error: unknown) => {
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
              ws.close();
            }
          }).finally(() => {
            pendingFrameAdmissions -= 1;
          });
        };
        for (const frame of pending.splice(0)) {
          const parsedFrame = TerminalTabClientFrameSchema.parse(frame);
          if (terminalAttachmentAllowsFrame(attachmentMode, parsedFrame)) {
            sendAuthorizedFrame(parsedFrame);
          } else {
            ws.send(JSON.stringify({ type: "error", code: "read_only", message: "Terminal is read-only" }));
          }
        }
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
      if (attachmentMode && !terminalAttachmentAllowsFrame(attachmentMode, parsed.data)) {
        ws.send(JSON.stringify({ type: "error", code: "read_only", message: "Terminal is read-only" }));
      } else if (sendAuthorizedFrame) sendAuthorizedFrame(parsed.data);
      else if (pending.length < 32) pending.push(parsed.data);
      else ws.close();
    },
    onClose() {
      if (stream) captureTerminalEvent("close", { client: clientResult.success ? clientResult.data : undefined });
      closed = true;
      pending.splice(0);
      sendAuthorizedFrame = null;
      stream?.close();
      stream = null;
    },
  };
}
