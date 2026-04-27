import type { ChildProcess } from "node:child_process";
import { z } from "zod/v4";
import { ShellReplayBuffer } from "./replay-buffer.js";
import type { ScrollbackStore } from "./scrollback-store.js";
import { validateSessionName } from "./names.js";

const ShellWsInputSchema = z.object({
  type: z.literal("input"),
  data: z.string().max(65_536),
});

const ShellWsResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

const ShellWsDetachSchema = z.object({
  type: z.literal("detach"),
});

const ShellWsClientMessageSchema = z.union([
  ShellWsInputSchema,
  ShellWsResizeSchema,
  ShellWsDetachSchema,
]);

export interface ShellWsSocket {
  send(data: string): void;
  close?: () => void;
}

interface ShellWsRegistry {
  list(): Promise<Array<{ name: string; status?: "active" | "exited" }>>;
}

interface ShellWsAdapter {
  attachSession(name: string, options?: { signal?: AbortSignal }): ChildProcess;
}

export interface ShellWsHandlerOptions {
  registry: ShellWsRegistry;
  adapter: ShellWsAdapter;
  scrollbackStore?: ScrollbackStore;
  maxReplayBytes?: number;
  maxBuffers?: number;
}

export interface ShellWsOpenOptions {
  ws: ShellWsSocket;
  session: string;
  fromSeq?: number;
}

export interface ShellWsSession {
  onMessage(raw: string): void;
  onClose(): void;
}

class ReplayBufferCache {
  private readonly buffers = new Map<string, ShellReplayBuffer>();
  private readonly maxBuffers: number;

  constructor(
    private readonly options: {
      scrollbackStore?: ScrollbackStore;
      maxReplayBytes?: number;
      maxBuffers?: number;
    },
  ) {
    this.maxBuffers = options.maxBuffers ?? 20;
  }

  get(name: string): ShellReplayBuffer {
    const existing = this.buffers.get(name);
    if (existing) {
      this.buffers.delete(name);
      this.buffers.set(name, existing);
      return existing;
    }

    if (this.buffers.size >= this.maxBuffers) {
      const oldest = this.buffers.keys().next().value as string | undefined;
      if (oldest) {
        this.buffers.delete(oldest);
      }
    }

    const next = new ShellReplayBuffer({
      maxBytes: this.options.maxReplayBytes,
      scrollbackStore: this.options.scrollbackStore,
      sessionName: name,
    });
    this.buffers.set(name, next);
    return next;
  }
}

export function createShellWsHandler(options: ShellWsHandlerOptions) {
  const buffers = new ReplayBufferCache({
    scrollbackStore: options.scrollbackStore,
    maxReplayBytes: options.maxReplayBytes,
    maxBuffers: options.maxBuffers,
  });

  async function open({ ws, session, fromSeq = 0 }: ShellWsOpenOptions): Promise<ShellWsSession> {
    const safeName = validateSessionName(session);
    const sessions = await options.registry.list();
    const info = sessions.find((candidate) => candidate.name === safeName);
    if (!info) {
      sendJson(ws, {
        type: "error",
        code: "session_not_found",
        message: "Session not found",
      });
      ws.close?.();
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const abortController = new AbortController();
    const replayBuffer = buffers.get(safeName);
    const child = options.adapter.attachSession(safeName, {
      signal: abortController.signal,
    });
    let closed = false;
    const cleanupProcessListeners = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onChildClose);
      child.off("error", onChildError);
    };

    sendJson(ws, {
      type: "attached",
      session: safeName,
      state: info.status === "exited" ? "exited" : "running",
      fromSeq,
    });

    for (const event of await replayBuffer.replayFromSeq(fromSeq)) {
      if (event.type === "replay-evicted") {
        continue;
      }
      sendJson(ws, event);
    }

    const onStdout = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      void replayBuffer.writePersistent(data)
        .then((result) => {
          if (result.seq !== null) {
            sendJson(ws, { type: "output", seq: result.seq, data });
          }
        })
        .catch((err: unknown) => {
          console.warn("[shell] failed to persist terminal output:", err instanceof Error ? err.message : String(err));
        });
    };
    const onStderr = (chunk: Buffer | string) => {
      // zellij stderr may contain paths or implementation details; keep it server-side only.
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (length > 0) {
        console.warn("[shell] zellij attach emitted stderr");
      }
    };
    const onChildClose = (code: number | null) => {
      if (closed) {
        return;
      }
      closed = true;
      cleanupProcessListeners();
      sendJson(ws, { type: "exit", code: code ?? null });
    };
    const onChildError = (err: unknown) => {
      console.warn("[shell] zellij attach process failed:", err instanceof Error ? err.message : String(err));
      if (!closed) {
        sendJson(ws, {
          type: "error",
          code: "attach_failed",
          message: "Shell attach failed",
        });
      }
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("close", onChildClose);
    child.once("error", onChildError);

    const closeSession = () => {
      if (closed) {
        return;
      }
      closed = true;
      abortController.abort();
      cleanupProcessListeners();
      child.kill();
    };

    return {
      onMessage(raw: string) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err: unknown) {
          console.warn("[shell] invalid terminal websocket JSON:", err instanceof Error ? err.message : String(err));
          sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid message" });
          return;
        }

        const result = ShellWsClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid message" });
          return;
        }

        const msg = result.data;
        if (msg.type === "detach") {
          closeSession();
          ws.close?.();
          return;
        }
        if (msg.type === "input") {
          child.stdin?.write(msg.data);
        }
        // child_process does not expose PTY resize. The message is validated
        // and accepted so clients can use the same protocol as PTY-backed paths.
      },
      onClose: closeSession,
    };
  }

  return { open };
}

function sendJson(ws: ShellWsSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (err: unknown) {
    console.warn("[shell] terminal websocket send failed:", err instanceof Error ? err.message : String(err));
  }
}
