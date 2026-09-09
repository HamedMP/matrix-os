import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import {
  TerminalTabClientFrameSchema,
  TerminalTabServerFrameSchema,
  TerminalTabSchema,
  TerminalWorkspaceSchema,
  type TerminalPaneAction,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { terminalRuntimeErrorFromDetails } from "./errors.js";
import { encodeSocketFrame, SocketFrameDecoder } from "./socket-framing.js";
import { MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES } from "./limits.js";
import {
  TerminalRuntimeResponseSchema,
  type TerminalRuntimeRequest,
} from "./socket-protocol.js";

export interface TerminalRuntimeSocketClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export interface TerminalRuntimeSocketStream {
  send(frame: z.input<typeof TerminalTabClientFrameSchema>): void;
  close(): void;
}

export class TerminalRuntimeSocketClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: TerminalRuntimeSocketClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listWorkspaces(): Promise<TerminalWorkspace[]> {
    return z.array(TerminalWorkspaceSchema).max(1_000).parse(await this.call("ListWorkspaces", {}));
  }

  async ensureWorkspace(input: { projectId?: string } = {}): Promise<TerminalWorkspace> {
    return TerminalWorkspaceSchema.parse(await this.call("EnsureWorkspace", input));
  }

  async createTab(workspaceId: string, input: {
    name: string;
    cwd: string;
    accessScope?: TerminalTab["accessScope"];
    command?: string[];
    agent?: TerminalTab["agent"];
  }): Promise<TerminalTab> {
    return TerminalTabSchema.parse(await this.call("CreateTab", { workspaceId, ...input }));
  }

  async getSnapshot(ref: { workspaceId: string; tabId: string }): Promise<unknown> {
    return this.call("GetSnapshot", ref);
  }

  async renameTab(ref: { workspaceId: string; tabId: string }, input: { name: string; baseRevision: number }): Promise<TerminalTab> {
    return TerminalTabSchema.parse(await this.call("RenameTab", { ...ref, ...input }));
  }

  async reorderTabs(workspaceId: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace> {
    return TerminalWorkspaceSchema.parse(await this.call("ReorderTabs", { workspaceId, ...input }));
  }

  async terminateTab(ref: { workspaceId: string; tabId: string }): Promise<void> {
    await this.call("TerminateTab", ref);
  }

  async paneAction(ref: { workspaceId: string; tabId: string }, action: TerminalPaneAction): Promise<void> {
    await this.call("PaneAction", { ...ref, action });
  }

  async writeInput(ref: { workspaceId: string; tabId: string }, data: string): Promise<void> {
    await this.call("WriteInput", { ...ref, data });
  }

  async updateTabUiState(ref: { workspaceId: string; tabId: string }, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    pinned?: boolean;
    baseRevision: number;
  }): Promise<TerminalTab> {
    return TerminalTabSchema.parse(await this.call("UpdateTabUiState", { ...ref, ...input }));
  }

  async resize(ref: { workspaceId: string; tabId: string }, input: {
    mode: "hard" | "soft";
    size: { cols: number; rows: number };
  }): Promise<TerminalWorkspace> {
    return TerminalWorkspaceSchema.parse(await this.call("Resize", { ...ref, ...input }));
  }

  async deletionImpact(workspaceId: string): Promise<{ runningTabs: number; tabs: TerminalTab[] }> {
    return z.object({ runningTabs: z.number().int().min(0), tabs: z.array(TerminalTabSchema).max(10_000) }).parse(
      await this.call("DeletionImpact", { workspaceId }),
    );
  }

  async deleteWorkspace(workspaceId: string, input: { confirmTerminate: boolean }): Promise<void> {
    await this.call("DeleteWorkspace", { workspaceId, ...input });
  }

  attach(input: {
    ref: { workspaceId: string; tabId: string };
    viewerId: string;
    fromSeq?: number;
    mode: "hard" | "soft";
    size: { cols: number; rows: number };
    onFrame(frame: z.infer<typeof TerminalTabServerFrameSchema>): void;
    onClose(): void;
    onError(error: Error): void;
  }): TerminalRuntimeSocketStream {
    const requestId = `req_${randomBytes(16).toString("hex")}`;
    const socket = createConnection(this.socketPath);
    const decoder = new SocketFrameDecoder(MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      socket.end();
    };
    socket.once("connect", () => socket.write(encodeSocketFrame({
      version: 1,
      requestId,
      operation: "Attach",
      input: { ...input.ref, viewerId: input.viewerId, fromSeq: input.fromSeq ?? 0, mode: input.mode, size: input.size },
    })));
    socket.on("data", (chunk) => {
      try {
        for (const raw of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          input.onFrame(TerminalTabServerFrameSchema.parse(raw));
        }
      } catch (error) {
        input.onError(error instanceof Error ? error : new Error("Invalid terminal runtime frame"));
        socket.destroy();
      }
    });
    socket.once("error", (error) => input.onError(error));
    socket.once("close", () => { closed = true; input.onClose(); });
    return {
      send: (frame) => {
        if (closed) throw new Error("Terminal runtime stream closed");
        socket.write(encodeSocketFrame(TerminalTabClientFrameSchema.parse(frame)));
      },
      close,
    };
  }

  private call(
    operation: TerminalRuntimeRequest["operation"],
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = `req_${randomBytes(16).toString("hex")}`;
    const request = { version: 1, requestId, operation, input };
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const decoder = new SocketFrameDecoder(MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Terminal runtime unavailable"));
      }, this.timeoutMs);
      timer.unref();
      const finish = () => clearTimeout(timer);
      socket.once("connect", () => socket.write(encodeSocketFrame(request)));
      socket.on("data", (chunk) => {
        try {
          const [raw] = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (raw === undefined) return;
          const response = TerminalRuntimeResponseSchema.parse(raw);
          if (!response.ok) throw terminalRuntimeErrorFromDetails(response.error);
          if (response.requestId !== requestId) throw new Error("Terminal runtime response mismatch");
          finish();
          socket.end();
          resolve(response.result);
        } catch (error) {
          finish();
          socket.destroy();
          reject(error);
        }
      });
      socket.once("error", (error) => { finish(); reject(error); });
    });
  }
}
