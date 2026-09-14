import { randomBytes } from "node:crypto";
import {
  TerminalRefSchema,
  TerminalTabClientFrameSchema,
  type TerminalRef,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { z } from "zod/v4";
import type { AgentKind } from "./shell/agent-session-state.js";
import type { WorkspaceError } from "./project-manager.js";
import type { WorkspaceSession } from "./agent-session-manager.js";

type BridgeMode = "owner" | "observe";

interface SessionRuntimeBridgeOptions {
  now?: () => number;
  createAttachmentToken?: () => string;
  maxAttachments?: number;
  attachmentTtlMs?: number;
}

interface SessionAttachment {
  ownerId: string;
  terminalRef: TerminalRef;
  mode: BridgeMode;
  expiresAt: number;
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

const RegisterOptionsSchema = z.object({
  mode: z.enum(["owner", "observe"]),
});
const AttachmentTokenSchema = z.string().length(48).regex(/^[a-f0-9]+$/);
const ConsumeAttachmentSchema = z.object({
  attachmentToken: AttachmentTokenSchema,
  ownerId: z.string().min(1).max(256),
  terminalRef: TerminalRefSchema,
}).strict();
const DEFAULT_MAX_ATTACHMENTS = 512;
const DEFAULT_ATTACHMENT_TTL_MS = 60_000;

type ProviderLoginRuntime = Pick<TerminalRuntimeSocketClient,
  "listWorkspaces" | "ensureWorkspace" | "createTab" | "renameTab" | "terminateTab">;

type NamedTerminal = { name: string };

function providerLoginRegistryError(code: "session_not_found" | "session_exists", message: string): Error {
  return Object.assign(new Error(message), { code });
}

function matchingProviderTabs(workspaces: readonly TerminalWorkspace[], name: string): TerminalTab[] {
  return workspaces.flatMap((workspace) => workspace.tabs.filter((tab) => tab.name === name));
}

function providerLoginCwd(cwd: string | undefined): string {
  if (!cwd || cwd === "~") return "";
  return cwd.startsWith("~/") ? cwd.slice(2) : cwd;
}

export function createProviderLoginTerminalRegistry(runtime: ProviderLoginRuntime) {
  async function find(name: string): Promise<TerminalTab> {
    const matches = matchingProviderTabs(await runtime.listWorkspaces(), name);
    if (matches.length === 0) {
      throw providerLoginRegistryError("session_not_found", "Provider terminal was not found");
    }
    if (matches.length !== 1) {
      throw new Error("Provider terminal identity is ambiguous");
    }
    return matches[0]!;
  }

  async function findOptional(name: string): Promise<TerminalTab | undefined> {
    try {
      return await find(name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "session_not_found") return undefined;
      throw error;
    }
  }

  return {
    async create(input: {
      name: string;
      cwd?: string;
      cmd?: string;
      agent?: AgentKind;
      exclusive?: boolean;
    }): Promise<NamedTerminal> {
      const existing = await findOptional(input.name);
      if (existing) {
        if (input.exclusive) {
          throw providerLoginRegistryError("session_exists", "Provider terminal already exists");
        }
        return { name: existing.name };
      }
      const workspace = await runtime.ensureWorkspace();
      const tab = await runtime.createTab(workspace.id, {
        name: input.name,
        cwd: providerLoginCwd(input.cwd),
        ...(input.cmd ? { command: ["sh", "-lc", input.cmd] } : {}),
        ...(input.agent ? { agent: { providerId: input.agent } } : {}),
      });
      return { name: tab.name };
    },

    async get(name: string): Promise<NamedTerminal> {
      return { name: (await find(name)).name };
    },

    async delete(name: string, options: { force?: boolean } = {}): Promise<void> {
      const tab = await findOptional(name);
      if (!tab) {
        if (options.force) return;
        throw providerLoginRegistryError("session_not_found", "Provider terminal was not found");
      }
      await runtime.terminateTab({ workspaceId: tab.workspaceId, tabId: tab.id });
    },

    async rename(name: string, nextName: string): Promise<NamedTerminal> {
      const tab = await find(name);
      if (name === nextName) return { name };
      if (await findOptional(nextName)) {
        throw providerLoginRegistryError("session_exists", "Provider terminal already exists");
      }
      const renamed = await runtime.renameTab(
        { workspaceId: tab.workspaceId, tabId: tab.id },
        { name: nextName, baseRevision: tab.revision },
      );
      return { name: renamed.name };
    },

    async observeAgentLiveness(name: string, agent: AgentKind): Promise<"running" | "stopped" | "unknown"> {
      const tab = await find(name);
      if (["exited", "failed", "unavailable"].includes(tab.status)) return "stopped";
      if (!tab.agent) return "unknown";
      return tab.agent.providerId === agent ? "running" : "stopped";
    },
  };
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function isAttachable(session: WorkspaceSession): boolean {
  return ["starting", "running", "idle", "waiting"].includes(session.runtime.status);
}

export function terminalAttachmentAllowsFrame(
  mode: BridgeMode,
  frame: z.input<typeof TerminalTabClientFrameSchema>,
): boolean {
  if (mode === "owner") return true;
  return frame.type !== "input"
    && frame.type !== "binary"
    && !(frame.type === "resize" && frame.mode === "hard");
}

export async function resolveTerminalAttachmentMode(
  input: {
    attachmentToken?: string;
    ownerId: string;
    terminalRef: TerminalRef;
  },
  dependencies: {
    consumeSessionAttachment: (input: z.input<typeof ConsumeAttachmentSchema>) =>
      { ok: true; mode: BridgeMode } | Failure;
    requiresAttachmentToken: (ref: TerminalRef) => Promise<boolean>;
  },
): Promise<BridgeMode> {
  if (input.attachmentToken) {
    const attachment = dependencies.consumeSessionAttachment({
      attachmentToken: input.attachmentToken,
      ownerId: input.ownerId,
      terminalRef: input.terminalRef,
    });
    if (!attachment.ok) throw new Error("Terminal attachment capability rejected");
    return attachment.mode;
  }
  if (await dependencies.requiresAttachmentToken(input.terminalRef)) {
    throw new Error("Terminal attachment capability required");
  }
  return "owner";
}

export function createSessionRuntimeBridge(options: SessionRuntimeBridgeOptions = {}) {
  const now = options.now ?? Date.now;
  const createAttachmentToken = options.createAttachmentToken
    ?? (() => randomBytes(24).toString("hex"));
  const maxAttachments = z.number().int().min(1).max(4_096)
    .parse(options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS);
  const attachmentTtlMs = z.number().int().min(1_000).max(10 * 60_000)
    .parse(options.attachmentTtlMs ?? DEFAULT_ATTACHMENT_TTL_MS);
  const attachments = new Map<string, SessionAttachment>();

  function sweepExpiredAttachments(): void {
    const currentTime = now();
    for (const [token, attachment] of attachments) {
      if (attachment.expiresAt <= currentTime) attachments.delete(token);
    }
  }

  function issueAttachment(session: WorkspaceSession, mode: BridgeMode): string {
    sweepExpiredAttachments();
    while (attachments.size >= maxAttachments) {
      const oldestToken = attachments.keys().next().value;
      if (oldestToken === undefined) break;
      attachments.delete(oldestToken);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = AttachmentTokenSchema.parse(createAttachmentToken());
      if (attachments.has(token)) continue;
      attachments.set(token, {
        ownerId: session.ownerId,
        terminalRef: session.terminalRef,
        mode,
        expiresAt: now() + attachmentTtlMs,
      });
      return token;
    }
    throw new Error("Unable to allocate terminal attachment capability");
  }

  return {
    registerSession(
      session: WorkspaceSession,
      rawOptions: { mode: BridgeMode },
    ): { ok: true; mode: BridgeMode; terminalRef: TerminalRef; attachmentToken: string } | Failure {
      const parsed = RegisterOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) {
        return failure(400, "invalid_bridge_request", "Bridge request is invalid");
      }
      if (!isAttachable(session)) {
        return failure(409, "session_unavailable", "Session is not attachable");
      }

      if (session.runtime.type === "zellij") {
        return {
          ok: true,
          mode: parsed.data.mode,
          terminalRef: session.terminalRef,
          attachmentToken: issueAttachment(session, parsed.data.mode),
        };
      }

      return failure(400, "runtime_unsupported", "Session runtime is unsupported");
    },

    consumeSessionAttachment(
      rawInput: z.input<typeof ConsumeAttachmentSchema>,
    ): { ok: true; mode: BridgeMode } | Failure {
      const parsed = ConsumeAttachmentSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failure(403, "attachment_not_authorized", "Terminal attachment is not authorized");
      }
      sweepExpiredAttachments();
      const attachment = attachments.get(parsed.data.attachmentToken);
      attachments.delete(parsed.data.attachmentToken);
      if (!attachment
        || attachment.ownerId !== parsed.data.ownerId
        || attachment.terminalRef.workspaceId !== parsed.data.terminalRef.workspaceId
        || attachment.terminalRef.tabId !== parsed.data.terminalRef.tabId) {
        return failure(403, "attachment_not_authorized", "Terminal attachment is not authorized");
      }
      return { ok: true, mode: attachment.mode };
    },

    close(): void {
      attachments.clear();
    },
  };
}
