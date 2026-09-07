import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { validateSessionName } from "../shell/names.js";
import type { ChatOwner } from "./records.js";

export async function authorizeStandaloneTerminalAttach(input: {
  repository: {
    listBoundTerminalSessionIds(
      owner: ChatOwner,
      sessionIds: readonly string[],
    ): Promise<readonly string[]>;
  };
  owner: ChatOwner;
  sessionId: string;
}): Promise<boolean> {
  try {
    const sessionId = validateSessionName(input.sessionId);
    const boundSessionIds = await input.repository.listBoundTerminalSessionIds(
      input.owner,
      [sessionId],
    );
    return !boundSessionIds.includes(sessionId);
  } catch (err: unknown) {
    console.warn(
      "[chat] standalone terminal attach authorization failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

export async function getAuthorizedChatTerminal(input: {
  repository: {
    getTerminalBinding(
      owner: ChatOwner,
      chatId: string,
      sessionId: string,
    ): Promise<{ sessionCreatedAt: string | null } | null>;
  };
  registry: { get(name: string): Promise<unknown> };
  owner: ChatOwner;
  chatId: string;
  sessionId: string;
}): Promise<{ sessionId: string; createdAt: string } | null> {
  try {
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const sessionId = validateSessionName(input.sessionId);
    const binding = await input.repository.getTerminalBinding(input.owner, chatId, sessionId);
    if (!binding?.sessionCreatedAt) return null;
    const session = await input.registry.get(sessionId);
    if (!session || typeof session !== "object") return null;
    const candidate = session as {
      name?: unknown;
      status?: unknown;
      recoverable?: unknown;
      createdAt?: unknown;
      incarnationVerified?: unknown;
    };
    if (candidate.name !== sessionId
      || candidate.status !== "active"
      || candidate.recoverable === true
      || candidate.incarnationVerified !== true
      || candidate.createdAt !== binding.sessionCreatedAt) return null;
    return { sessionId, createdAt: binding.sessionCreatedAt };
  } catch (err: unknown) {
    console.warn(
      "[chat] terminal attach authorization failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Boolean compatibility helper for existing attach callers. */
export async function authorizeChatTerminalAttach(
  input: Parameters<typeof getAuthorizedChatTerminal>[0],
): Promise<boolean> {
  return (await getAuthorizedChatTerminal(input)) !== null;
}
