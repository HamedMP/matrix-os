import type { SpawnFn } from "../dispatcher.js";

export interface GatewayConfig {
  homePath: string;
  port?: number;
  model?: string;
  maxTurns?: number;
  spawnFn?: SpawnFn;
  syncReport?: { added: string[]; updated: string[]; skipped: string[] };
}

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string; eventId?: string }
  | { type: "kernel:text"; text: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string; eventId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string; eventId?: string }
  | { type: "kernel:error"; message: string; requestId?: string; eventId?: string }
  | { type: "kernel:aborted"; requestId?: string; eventId?: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | {
      type: "approval:request";
      id: string;
      toolName: string;
      args: unknown;
      timeout: number;
      requestId?: string;
      eventId?: string;
    }
  | {
      type: "client:ack";
      actionId: string;
      actionType: string;
      status: "accepted" | "rejected";
      retryable?: boolean;
    }
  | { type: "os:sync-report"; payload: { added: string[]; updated: string[]; skipped: string[] } }
  | { type: "data:change"; app: string; key: string }
  | { type: "integration:connected"; service: string; accountLabel: string }
  | { type: "integration:disconnected"; service: string; id: string }
  | { type: "integration:expired"; service: string; id: string; accountLabel: string }
  | { type: "pong" }
  | { type: "sync:change"; files: Array<{ path: string; hash: string; size: number; action: string }>; peerId: string; manifestVersion: number }
  | { type: "sync:conflict"; path: string; localHash: string; remoteHash: string; remotePeerId: string; conflictPath: string }
  | { type: "sync:peer-join"; peerId: string; hostname: string; platform: string }
  | { type: "sync:peer-leave"; peerId: string }
  | { type: "sync:share-invite"; shareId: string; ownerHandle: string; path: string; role: string }
  | { type: "sync:access-revoked"; shareId: string; ownerHandle: string; path: string };
