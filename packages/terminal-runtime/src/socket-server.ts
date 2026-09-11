import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  TerminalTabClientFrameSchema,
  type TerminalPaneAction,
  type TerminalRef,
  type TerminalTabServerFrameSchema,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { terminalRuntimeErrorDetails } from "./errors.js";
import type { TerminalSnapshot } from "./workspace-store.js";
import { encodeSocketFrame, SocketFrameDecoder } from "./socket-framing.js";
import { MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES } from "./limits.js";
import {
  TerminalRuntimeRequestSchema,
  type TerminalRuntimeRequest,
  type TerminalRuntimeResponse,
} from "./socket-protocol.js";

export interface TerminalRuntimeControlApi {
  listWorkspaces(): Promise<TerminalWorkspace[]>;
  ensureWorkspace(input?: { projectId?: string }): Promise<TerminalWorkspace>;
  createTab(workspaceId: string, input: {
    tabId?: string;
    name: string;
    cwd: string;
    accessScope?: TerminalTab["accessScope"];
    command?: string[];
    agent?: TerminalTab["agent"];
  }): Promise<TerminalTab>;
  getSnapshot(ref: { workspaceId: string; tabId: string }): Promise<TerminalSnapshot | undefined>;
  renameTab(ref: { workspaceId: string; tabId: string }, input: { name: string; baseRevision: number }): Promise<TerminalTab>;
  reorderTabs(workspaceId: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace>;
  terminateTab(ref: { workspaceId: string; tabId: string }): Promise<void>;
  paneAction(ref: { workspaceId: string; tabId: string }, action: TerminalPaneAction): Promise<void>;
  writeInput(ref: { workspaceId: string; tabId: string }, data: string): Promise<void>;
  updateTabUiState(ref: { workspaceId: string; tabId: string }, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    pinned?: boolean;
    baseRevision: number;
  }): Promise<TerminalTab>;
  resize(ref: { workspaceId: string; tabId: string }, input: { mode: "hard" | "soft"; size: { cols: number; rows: number } }): Promise<TerminalWorkspace>;
  deletionImpact(workspaceId: string): Promise<{ runningTabs: number; tabs: TerminalTab[] }>;
  deleteWorkspace(workspaceId: string, input: { confirmTerminate: boolean }): Promise<void>;
  attach(ref: TerminalRef, input: {
    viewerId: string;
    send(data: Uint8Array): void | Promise<void>;
    onExit(exitCode: number | null): void | Promise<void>;
  }): Promise<{ write(data: string): Promise<void>; touch(): void; detach(): Promise<void> }>;
}

type TerminalServerFrame = z.infer<typeof TerminalTabServerFrameSchema>;
const LIVE_TAIL_FROM_SEQ = Number.MAX_SAFE_INTEGER;

function encodeSocketResponseFrame(value: unknown): Buffer {
  return encodeSocketFrame(value, MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES);
}

export interface TerminalRuntimeSocketServerOptions {
  socketPath: string;
  runtime: TerminalRuntimeControlApi;
  maxConnections?: number;
  idleTimeoutMs?: number;
}

export class TerminalRuntimeSocketServer {
  private readonly options: TerminalRuntimeSocketServerOptions;
  private readonly connections = new Set<Socket>();
  private server: Server | null = null;

  constructor(options: TerminalRuntimeSocketServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketDirectory = dirname(this.options.socketPath);
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const directoryEntry = await lstat(socketDirectory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error("Terminal runtime socket directory is invalid");
    }
    await chmod(socketDirectory, 0o700);
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const previousUmask = process.umask(0o177);
      try {
        server.listen(this.options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      } finally {
        process.umask(previousUmask);
      }
    });
    // Defense in depth in case platform-specific socket creation ignores umask.
    await chmod(this.options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.connections) {
      socket.end(encodeSocketResponseFrame({
        version: 1,
        ok: false,
        error: { code: "unavailable", message: "Terminal runtime is restarting" },
      } satisfies TerminalRuntimeResponse));
    }
    this.connections.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.options.socketPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }

  private accept(socket: Socket): void {
    if (this.connections.size >= (this.options.maxConnections ?? 256)) {
      socket.end(encodeSocketResponseFrame({
        version: 1,
        ok: false,
        error: { code: "unavailable", message: "Terminal runtime is busy" },
      } satisfies TerminalRuntimeResponse));
      return;
    }
    this.connections.add(socket);
    socket.setTimeout(this.options.idleTimeoutMs ?? 30_000, () => socket.destroy());
    const decoder = new SocketFrameDecoder();
    let handled = false;
    let streamMessage: ((raw: unknown) => Promise<void>) | null = null;
    const pendingStreamFrames: unknown[] = [];
    socket.on("data", (chunk) => {
      try {
        const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        for (const frame of frames) {
          if (!handled) {
            handled = true;
            void this.handle(socket, frame).then((handler) => {
              streamMessage = handler;
              if (!handler) return;
              for (const pending of pendingStreamFrames.splice(0)) {
                void handler(pending).catch((error: unknown) => {
                  console.error(
                    "[terminal-runtime] buffered stream frame failed",
                    error instanceof Error ? error.name : "unknown_error",
                  );
                  socket.destroy();
                });
              }
            }).catch((error: unknown) => {
              console.error("[terminal-runtime] attach request failed", error);
              socket.end(encodeSocketResponseFrame({
                version: 1,
                ok: false,
                error: { code: "failed", message: "Terminal operation failed" },
              } satisfies TerminalRuntimeResponse));
            });
          } else if (streamMessage) {
            void streamMessage(frame).catch((error: unknown) => {
              console.error(
                "[terminal-runtime] stream frame failed",
                error instanceof Error ? error.name : "unknown_error",
              );
              socket.destroy();
            });
          } else if (pendingStreamFrames.length < 32) {
            pendingStreamFrames.push(frame);
          } else {
            socket.destroy();
          }
        }
      } catch (error) {
        console.error(
          "[terminal-runtime] invalid socket frame",
          error instanceof Error ? error.name : "unknown_error",
        );
        handled = true;
        socket.end(encodeSocketResponseFrame({
          version: 1,
          ok: false,
          error: { code: "invalid_request", message: "Invalid terminal runtime request" },
        } satisfies TerminalRuntimeResponse));
      }
    });
    socket.once("close", () => this.connections.delete(socket));
    socket.once("error", () => this.connections.delete(socket));
  }

  private async handle(socket: Socket, raw: unknown): Promise<((raw: unknown) => Promise<void>) | null> {
    const parsed = TerminalRuntimeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      socket.end(encodeSocketResponseFrame({
        version: 1,
        ok: false,
        error: { code: "invalid_request", message: "Invalid terminal runtime request" },
      } satisfies TerminalRuntimeResponse));
      return null;
    }
    if (parsed.data.operation === "Attach") return this.handleAttach(socket, parsed.data);
    try {
      const result = await this.dispatch(parsed.data);
      socket.end(encodeSocketResponseFrame({
        version: 1,
        requestId: parsed.data.requestId,
        ok: true,
        result,
      } satisfies TerminalRuntimeResponse));
      return null;
    } catch (error: unknown) {
      console.error("[terminal-runtime] control request failed", error);
      const details = terminalRuntimeErrorDetails(error);
      socket.end(encodeSocketResponseFrame({
        version: 1,
        requestId: parsed.data.requestId,
        ok: false,
        error: details,
      } satisfies TerminalRuntimeResponse));
      return null;
    }
  }

  private async handleAttach(
    socket: Socket,
    request: Extract<TerminalRuntimeRequest, { operation: "Attach" }>,
  ): Promise<(raw: unknown) => Promise<void>> {
    socket.setTimeout(0);
    const ref = { workspaceId: request.input.workspaceId, tabId: request.input.tabId };
    const resized = await this.options.runtime.resize(ref, request.input);
    const tab = resized.tabs.find((candidate) => candidate.id === ref.tabId);
    if (!tab) throw new Error("Terminal tab not found");
    const snapshot = await this.options.runtime.getSnapshot(ref);
    const effectiveFromSeq = request.input.fromSeq === LIVE_TAIL_FROM_SEQ
      ? (snapshot?.seq ?? -1) + 1
      : request.input.fromSeq;
    let nextSeq = Math.max(effectiveFromSeq, (snapshot?.seq ?? -1) + 1);
    let revision = Math.max(tab.revision, snapshot?.revision ?? 0);
    const send = (frame: TerminalServerFrame) => {
      if (!socket.destroyed) socket.write(encodeSocketResponseFrame(frame));
    };
    send({
      type: "attached",
      terminalRef: ref,
      canonicalSize: resized.canonicalSize,
      revision,
      nextSeq,
    });
    if (snapshot) {
      send({ type: "replay-start", terminalRef: ref, revision, fromSeq: effectiveFromSeq });
      if (effectiveFromSeq < snapshot.seq) {
        send({ type: "replay-evicted", terminalRef: ref, revision, fromSeq: effectiveFromSeq, nextSeq: snapshot.seq });
      }
      send({
        type: "snapshot",
        terminalRef: ref,
        canonicalSize: resized.canonicalSize,
        revision,
        presentationRevision: snapshot.presentationRevision,
        seq: snapshot.seq,
        ansi: snapshot.ansi,
        viewport: { top: 0, rows: Math.min(snapshot.viewport.length || resized.canonicalSize.rows, 200) },
      });
      send({ type: "replay-end", terminalRef: ref, revision, nextSeq, toSeq: snapshot.seq });
    }
    const decoder = new TextDecoder();
    const viewer = await this.options.runtime.attach(ref, {
      viewerId: request.input.viewerId,
      send: (data) => {
        const text = decoder.decode(data, { stream: true });
        if (!text) return;
        send({ type: "output", terminalRef: ref, revision, seq: nextSeq++, data: text });
      },
      onExit: (exitCode) => {
        revision += 1;
        send({ type: "exit", terminalRef: ref, revision, exitCode });
        socket.end();
      },
    });
    let detached = false;
    const detach = async () => {
      if (detached) return;
      detached = true;
      await viewer.detach();
    };
    socket.once("close", () => { void detach(); });
    return async (raw) => {
      const frame = TerminalTabClientFrameSchema.parse(raw);
      if (frame.terminalRef.workspaceId !== ref.workspaceId || frame.terminalRef.tabId !== ref.tabId) {
        throw new Error("Terminal reference mismatch");
      }
      if (frame.type === "input") await viewer.write(frame.data);
      if (frame.type === "resize") {
        const workspace = await this.options.runtime.resize(ref, frame);
        revision = workspace.revision;
        send({ type: "canonical-size", terminalRef: ref, revision, canonicalSize: workspace.canonicalSize });
      }
      if (frame.type === "detach") {
        await detach();
        socket.end();
      }
      if (frame.type === "ping") viewer.touch();
      if (frame.type === "ping") {
        send({ type: "pong", terminalRef: ref, revision });
      }
    };
  }

  private dispatch(request: TerminalRuntimeRequest): Promise<unknown> {
    switch (request.operation) {
      case "ListWorkspaces": return this.options.runtime.listWorkspaces();
      case "EnsureWorkspace": return this.options.runtime.ensureWorkspace(request.input);
      case "CreateTab": return this.options.runtime.createTab(request.input.workspaceId, request.input);
      case "GetSnapshot": return this.options.runtime.getSnapshot(request.input);
      case "RenameTab": return this.options.runtime.renameTab(request.input, request.input);
      case "ReorderTabs": return this.options.runtime.reorderTabs(request.input.workspaceId, request.input);
      case "TerminateTab": return this.options.runtime.terminateTab(request.input).then(() => null);
      case "PaneAction": return this.options.runtime.paneAction(
        { workspaceId: request.input.workspaceId, tabId: request.input.tabId },
        request.input.action,
      ).then(() => null);
      case "WriteInput": return this.options.runtime.writeInput(request.input, request.input.data).then(() => null);
      case "UpdateTabUiState": return this.options.runtime.updateTabUiState(request.input, request.input);
      case "Resize": return this.options.runtime.resize(request.input, request.input);
      case "DeletionImpact": return this.options.runtime.deletionImpact(request.input.workspaceId);
      case "DeleteWorkspace": return this.options.runtime.deleteWorkspace(request.input.workspaceId, request.input).then(() => null);
      case "Attach": throw new Error("Attach must use stream dispatch");
    }
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket()) throw new Error("Terminal runtime socket path is occupied");
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
