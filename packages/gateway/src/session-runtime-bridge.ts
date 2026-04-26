import { resolve } from "node:path";
import { z } from "zod/v4";
import type { WorkspaceError } from "./project-manager.js";
import type { WorkspaceSession } from "./agent-session-manager.js";
import type { createZellijRuntime } from "./zellij-runtime.js";
import type { SessionRegistry } from "./session-registry.js";

type BridgeMode = "owner" | "observe";

type ZellijRuntime = Pick<ReturnType<typeof createZellijRuntime>, "attachCommand" | "observeCommand">;

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

function splitCommand(command: string[]): { command: "zellij" | "tmux"; args: string[] } | null {
  const [binary, ...args] = command;
  if (binary === "zellij" || binary === "tmux") {
    return { command: binary, args };
  }
  return null;
}

export function createSessionRuntimeBridge(options: {
  homePath: string;
  registry: Pick<SessionRegistry, "registerExternal" | "getSession">;
  zellijRuntime: ZellijRuntime;
}) {
  const homePath = resolve(options.homePath);

  return {
    registerSession(
      session: WorkspaceSession,
      rawOptions: { mode: BridgeMode },
    ): { ok: true; mode: BridgeMode; terminalSessionId: string } | Failure {
      const parsed = RegisterOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) {
        return failure(400, "invalid_bridge_request", "Bridge request is invalid");
      }
      if (!isAttachable(session)) {
        return failure(409, "session_unavailable", "Session is not attachable");
      }

      let command: { command: "zellij" | "tmux"; args: string[] } | null = null;
      if (session.runtime.type === "zellij") {
        if (!session.runtime.zellijSession) {
          return failure(409, "session_unavailable", "Session is not attachable");
        }
        command = splitCommand(parsed.data.mode === "observe"
          ? options.zellijRuntime.observeCommand(session.id)
          : options.zellijRuntime.attachCommand(session.id));
      } else if (session.runtime.type === "tmux") {
        if (!session.runtime.tmuxSession) {
          return failure(409, "session_unavailable", "Session is not attachable");
        }
        command = {
          command: "tmux",
          args: ["attach-session", "-t", session.runtime.tmuxSession],
        };
      }

      if (!command) {
        return failure(400, "runtime_unsupported", "Session runtime is unsupported");
      }

      const terminalSessionId = options.registry.registerExternal({
        cwd: homePath,
        command: command.command,
        args: command.args,
      });

      return { ok: true, mode: parsed.data.mode, terminalSessionId };
    },
  };
}
