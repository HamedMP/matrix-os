import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import {
  CanonicalChatIdSchema,
  MatrixComputerRuntimeSlotSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import type { OwnerScope } from "../state-ops.js";
import type { ShellRouteDeps } from "../shell/routes.js";
import { createPendingTerminalInputQueue } from "../shell/pending-input.js";
import { SESSION_NAME_PATTERN } from "../shell/names.js";
import {
  shellWsMessageDataToString,
  type ShellWsOpenOptions,
  type ShellWsSession,
  type ShellWsSocket,
} from "../shell/ws.js";
import type { ChatOwner } from "./records.js";
import { authorizeChatTerminalAttach } from "./terminal-authorization.js";

type ChatTerminalRepository = {
  getTerminalBinding(
    owner: ChatOwner,
    chatId: string,
    sessionId: string,
  ): Promise<{ sessionCreatedAt: string | null } | null>;
  listBoundTerminalSessionIds(owner: ChatOwner, sessionIds: readonly string[]): Promise<readonly string[]>;
};

type TerminalRegistry = {
  get(name: string): Promise<unknown>;
};

type TerminalSocketHandler = {
  open(options: ShellWsOpenOptions): Promise<ShellWsSession>;
};

export interface GatewayChatTerminalWiring {
  shellRouteDeps: Pick<ShellRouteDeps, "getPrincipal" | "listChatBoundSessionIds">;
  workspaceRouteDeps: {
    listChatBoundSessionIds?: (
      ownerScope: OwnerScope,
      sessionIds: readonly string[],
    ) => Promise<readonly string[]>;
  };
  registerSessionRoute<TRawSocket>(
    app: Hono,
    upgradeWebSocket: UpgradeWebSocket<TRawSocket>,
  ): void;
}

function canonicalOwner(ownerScope: OwnerScope): ChatOwner {
  return ownerScope.type === "org"
    ? { type: "organization", ownerId: ownerScope.id }
    : { type: "personal", ownerId: ownerScope.id };
}

const SafeSequenceQuerySchema = z.string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

const TerminalSessionQuerySchema = z.object({
  session: z.string().regex(SESSION_NAME_PATTERN),
  chat: CanonicalChatIdSchema.optional(),
  fromSeq: SafeSequenceQuerySchema.optional(),
  client: z.enum(["hard", "soft"]).optional(),
  cols: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().int().min(1).max(500)).optional(),
  rows: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  lease: z.literal("exclusive").optional(),
  token: z.string().min(1).max(8_192).optional(),
  runtime: MatrixComputerRuntimeSlotSchema.optional(),
}).strict().superRefine((query, ctx) => {
  if ((query.cols === undefined) !== (query.rows === undefined)) {
    ctx.addIssue({ code: "custom", message: "Terminal dimensions must be paired" });
  }
}).transform((query) => ({
  session: query.session,
  ...(query.chat ? { chatId: query.chat } : {}),
  fromSeq: query.fromSeq ?? 0,
  ...(query.client ? { clientClass: query.client } : {}),
  ...(query.cols !== undefined && query.rows !== undefined
    ? { declaredSize: { cols: query.cols, rows: query.rows } }
    : {}),
  exclusiveLease: query.lease === "exclusive",
}));

export function parseTerminalSizingParams(
  query: (name: string) => string | undefined,
): { clientClass?: "hard" | "soft"; declaredSize?: { cols: number; rows: number } } {
  const clientParam = query("client");
  const clientClass = clientParam === "hard" || clientParam === "soft" ? clientParam : undefined;
  const colsParam = query("cols");
  const rowsParam = query("rows");
  const cols = colsParam && /^\d{1,3}$/.test(colsParam) ? Number(colsParam) : null;
  const rows = rowsParam && /^\d{1,3}$/.test(rowsParam) ? Number(rowsParam) : null;
  const declaredSize = cols && rows && cols >= 1 && cols <= 500 && rows >= 1 && rows <= 200
    ? { cols, rows }
    : undefined;
  return { clientClass, declaredSize };
}

function createTerminalSessionEvents<TRawSocket>(
  c: Context,
  deps: {
    repository: ChatTerminalRepository | null;
    getPrincipal: (c: Context) => RequestPrincipal;
    registry: TerminalRegistry;
    shellWs: TerminalSocketHandler;
    onUnexpectedSendFailure: (context: string, err: unknown) => void;
  },
): WSEvents<TRawSocket> {
  const terminalQuery = TerminalSessionQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams.entries()),
  );
  let namedHandle: ShellWsSession | null = null;
  let namedSocketClosed = false;
  const pendingInput = createPendingTerminalInputQueue();

  return {
    onOpen(_evt, ws) {
      if (!terminalQuery.success) {
        ws.send(JSON.stringify({
          type: "error",
          code: "invalid_request",
          message: "Invalid request",
        }));
        ws.close();
        return;
      }
      const {
        session: namedSession,
        chatId,
        fromSeq,
        clientClass,
        declaredSize,
        exclusiveLease,
      } = terminalQuery.data;
      void (async () => {
        const principal = deps.getPrincipal(c);
        if (!deps.repository) {
          throw new Error("Chat terminal repository unavailable");
        }
        const owner: ChatOwner = { type: "personal", ownerId: principal.userId };
        if (chatId !== undefined) {
          if (!await authorizeChatTerminalAttach({
            repository: deps.repository,
            registry: deps.registry,
            owner,
            chatId,
            sessionId: namedSession,
          })) {
            throw new Error("Chat terminal attachment denied");
          }
        } else {
          const boundSessionIds = await deps.repository.listBoundTerminalSessionIds(owner, [namedSession]);
          if (boundSessionIds.includes(namedSession)) {
            throw new Error("Chat terminal attachment requires Chat context");
          }
        }
        return deps.shellWs.open({
          ws: ws as unknown as ShellWsSocket,
          session: namedSession,
          fromSeq,
          clientClass,
          declaredSize,
          exclusiveLease,
        });
      })().then((session) => {
        if (namedSocketClosed) {
          session.onClose();
          return;
        }
        namedHandle = session;
        pendingInput.drain((raw) => session.onMessage(raw));
      }).catch((err: unknown) => {
        console.warn(
          "[shell] terminal session attach failed:",
          err instanceof Error ? err.message : String(err),
        );
        pendingInput.clear();
        if (namedSocketClosed) return;
        try {
          ws.send(JSON.stringify({
            type: "error",
            code: "attach_failed",
            message: "Shell attach failed",
          }));
        } catch (sendErr: unknown) {
          deps.onUnexpectedSendFailure("Terminal WebSocket send failed", sendErr);
        }
        ws.close();
      });
    },
    onMessage(evt, ws) {
      const raw = shellWsMessageDataToString(evt.data);
      if (raw === null) return;
      if (namedHandle) {
        namedHandle.onMessage(raw);
        return;
      }
      if (!pendingInput.enqueue(raw)) {
        try {
          ws.send(JSON.stringify({
            type: "error",
            code: "buffer_overflow",
            message: "Input buffer overflow before session was ready",
          }));
        } catch (sendErr: unknown) {
          deps.onUnexpectedSendFailure("Terminal WebSocket send failed", sendErr);
        }
        ws.close();
      }
    },
    onClose() {
      namedSocketClosed = true;
      pendingInput.clear();
      namedHandle?.onClose();
      namedHandle = null;
    },
  };
}

export function createGatewayChatTerminalWiring(input: {
  repository: ChatTerminalRepository | null;
  getPrincipal: (c: Context) => RequestPrincipal;
  registry: TerminalRegistry;
  shellWs: TerminalSocketHandler;
  onUnexpectedSendFailure: (context: string, err: unknown) => void;
}): GatewayChatTerminalWiring {
  const shellRouteDeps: GatewayChatTerminalWiring["shellRouteDeps"] = input.repository
    ? {
        getPrincipal: input.getPrincipal,
        listChatBoundSessionIds: (principal, sessionIds) => input.repository!.listBoundTerminalSessionIds(
          { type: "personal", ownerId: principal.userId },
          sessionIds,
        ),
      }
    : {};
  const workspaceRouteDeps: GatewayChatTerminalWiring["workspaceRouteDeps"] = input.repository
    ? {
        listChatBoundSessionIds: (ownerScope, sessionIds) => input.repository!.listBoundTerminalSessionIds(
          canonicalOwner(ownerScope),
          sessionIds,
        ),
      }
    : {};

  return {
    shellRouteDeps,
    workspaceRouteDeps,
    registerSessionRoute<TRawSocket>(app: Hono, upgradeWebSocket: UpgradeWebSocket<TRawSocket>) {
      app.get(
        "/ws/terminal/session",
        upgradeWebSocket((c) => createTerminalSessionEvents<TRawSocket>(c, input)),
      );
    },
  };
}
