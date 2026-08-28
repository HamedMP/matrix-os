import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CanonicalChatExecutionRootRef, CanonicalChatRun } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import type { ChatOwner } from "./records.js";

interface ChatTerminalRepository {
  getLatestRunForTerminalBinding(
    owner: ChatOwner,
    chatId: string,
  ): Promise<Pick<CanonicalChatRun, "id" | "executionRoot"> | null>;
  getChatForTerminalBinding(
    owner: ChatOwner,
    chatId: string,
  ): Promise<{ projectId?: string } | null>;
  bindTerminalSession(owner: ChatOwner, input: {
    chatId: string;
    runId?: string;
    sessionId: string;
    sessionCreatedAt: string;
  }): Promise<boolean>;
}

export interface ChatTerminalSessionService {
  prepare(principal: RequestPrincipal, chatId: string): Promise<{ runId?: string; cwd?: string }>;
  bind(principal: RequestPrincipal, input: {
    chatId: string;
    runId?: string;
    sessionId: string;
    sessionCreatedAt: string;
  }): Promise<void>;
}

function ownerFromPrincipal(principal: RequestPrincipal): ChatOwner {
  return { type: "personal", ownerId: principal.userId };
}

function relativeTerminalCwd(homePath: string, absoluteRoot: string): string | undefined {
  const home = resolve(homePath);
  const root = resolve(absoluteRoot);
  const cwd = relative(home, root);
  if (cwd === "") return undefined;
  if (cwd === ".." || cwd.startsWith(`..${sep}`) || isAbsolute(cwd)) {
    throw new Error("Chat terminal root is outside Matrix Home");
  }
  return cwd;
}

export function createChatTerminalSessionService(options: {
  homePath: string;
  repository: ChatTerminalRepository;
  executionRoots: Pick<ChatExecutionRootResolver, "resolve">;
}): ChatTerminalSessionService {
  return {
    async prepare(principal, chatId) {
      const owner = ownerFromPrincipal(principal);
      const run = await options.repository.getLatestRunForTerminalBinding(owner, chatId);
      if (!run) {
        const chat = await options.repository.getChatForTerminalBinding(owner, chatId);
        if (!chat) throw new Error("Chat is unavailable");
        if (!chat.projectId) return {};
        const resolvedRoot = await options.executionRoots.resolve(owner, {
          kind: "project",
          projectId: chat.projectId,
        });
        const cwd = relativeTerminalCwd(options.homePath, resolvedRoot.primaryWorkspaceRoot);
        return cwd ? { cwd } : {};
      }
      if (!run.executionRoot) return { runId: run.id };
      const resolvedRoot = await options.executionRoots.resolve(
        owner,
        run.executionRoot as CanonicalChatExecutionRootRef,
      );
      const cwd = relativeTerminalCwd(options.homePath, resolvedRoot.primaryWorkspaceRoot);
      return { runId: run.id, ...(cwd ? { cwd } : {}) };
    },

    async bind(principal, input) {
      await options.repository.bindTerminalSession(ownerFromPrincipal(principal), input);
    },
  };
}
