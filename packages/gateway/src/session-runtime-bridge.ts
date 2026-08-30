import type { TerminalRef } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { WorkspaceError } from "./project-manager.js";
import type { WorkspaceSession } from "./agent-session-manager.js";

type BridgeMode = "owner" | "observe";

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

const RegisterOptionsSchema = z.object({
  mode: z.enum(["owner", "observe"]),
});

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function isAttachable(session: WorkspaceSession): boolean {
  return ["starting", "running", "idle", "waiting"].includes(session.runtime.status);
}

export function createSessionRuntimeBridge() {
  return {
    registerSession(
      session: WorkspaceSession,
      rawOptions: { mode: BridgeMode },
    ): { ok: true; mode: BridgeMode; terminalRef: TerminalRef } | Failure {
      const parsed = RegisterOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) {
        return failure(400, "invalid_bridge_request", "Bridge request is invalid");
      }
      if (!isAttachable(session)) {
        return failure(409, "session_unavailable", "Session is not attachable");
      }

      if (session.runtime.type === "zellij") {
        return { ok: true, mode: parsed.data.mode, terminalRef: session.terminalRef };
      }

      return failure(400, "runtime_unsupported", "Session runtime is unsupported");
    },
  };
}
