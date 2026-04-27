import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { SupportedAgentSchema, type AgentLaunchSandbox, type SupportedAgent } from "./agent-launcher.js";
import type { WorkspaceError } from "./project-manager.js";

export interface AgentSandboxStatus {
  available: boolean;
  enforced: boolean;
  requiresAdminOverride: boolean;
  reason: "ok" | "not_required" | "root_user" | "admin_override";
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
  sandboxStatus?: AgentSandboxStatus;
};

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const PreflightSchema = z.object({
  agent: SupportedAgentSchema,
  sessionId: SessionIdSchema,
  worktreePath: z.string().trim().min(1).max(4096),
  adminOverride: z.boolean().optional(),
});

function failure(status: number, code: string, message: string, sandboxStatus?: AgentSandboxStatus): Failure {
  return { ok: false, status, error: { code, message }, sandboxStatus };
}

function sandboxRequired(agent: SupportedAgent): boolean {
  return agent === "codex";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function statusForUid(uid: number, required: boolean): AgentSandboxStatus {
  if (!required) {
    return {
      available: true,
      enforced: false,
      requiresAdminOverride: false,
      reason: "not_required",
    };
  }
  if (uid === 0) {
    return {
      available: false,
      enforced: false,
      requiresAdminOverride: true,
      reason: "root_user",
    };
  }
  return {
    available: true,
    enforced: true,
    requiresAdminOverride: false,
    reason: "ok",
  };
}

function currentUid(getUid?: () => number): number {
  if (getUid) return getUid();
  if (typeof process.getuid === "function") return process.getuid();
  return 1000;
}

function isWithinHome(homePath: string, candidatePath: string): boolean {
  const resolved = resolve(candidatePath);
  return resolved === homePath || resolved.startsWith(`${homePath}/`);
}

export function createAgentSandbox(options: {
  homePath: string;
  getUid?: () => number;
}) {
  const homePath = resolve(options.homePath);

  return {
    async status(input?: { agent?: SupportedAgent }): Promise<AgentSandboxStatus> {
      const required = input?.agent ? sandboxRequired(input.agent) : true;
      return statusForUid(currentUid(options.getUid), required);
    },

    async preflight(input: unknown): Promise<
      | { ok: true; sandbox: AgentLaunchSandbox | undefined; status: AgentSandboxStatus }
      | Failure
    > {
      const parsed = PreflightSchema.safeParse(input);
      if (!parsed.success) {
        return failure(400, "invalid_sandbox_request", "Sandbox request is invalid");
      }
      const request = parsed.data;
      const required = sandboxRequired(request.agent);
      if (!required) {
        return {
          ok: true,
          sandbox: undefined,
          status: statusForUid(currentUid(options.getUid), false),
        };
      }

      const uid = currentUid(options.getUid);
      const uidStatus = statusForUid(uid, true);
      if (uidStatus.requiresAdminOverride) {
        if (request.adminOverride === true) {
          return {
            ok: true,
            sandbox: { enabled: false, adminOverride: true },
            status: {
              available: false,
              enforced: false,
              requiresAdminOverride: true,
              reason: "admin_override",
            },
          };
        }
        return failure(403, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
      }

      const resolvedWorktree = resolve(request.worktreePath);
      if (!isWithinHome(homePath, resolvedWorktree)) {
        return failure(400, "invalid_worktree_path", "Worktree path is invalid");
      }
      if (!await pathExists(resolvedWorktree)) {
        return failure(404, "not_found", "Worktree was not found");
      }

      const scratchPath = join(homePath, "system", "agent-scratch", request.sessionId);
      await mkdir(scratchPath, { recursive: true });
      return {
        ok: true,
        sandbox: {
          enabled: true,
          writableRoots: [resolvedWorktree, scratchPath],
        },
        status: uidStatus,
      };
    },
  };
}
