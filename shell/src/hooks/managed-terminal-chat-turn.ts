import {
  TerminalRefSchema, canonicalChatFileScope,
  type CanonicalChatDetailResponse, type CanonicalChatResourceReference,
} from "@matrix-os/contracts";
import { isManagedTerminalRef } from "@matrix-os/contracts/managed-terminal-control";
import { herdrControlParts } from "@matrix-os/ui/herdr-sessions";
import type { ChatSubmitOptions } from "./useChatState";

export type ManagedTerminalChatScope = { chatId: string; projectId: string; worktreeId: string };
export type ManagedTerminalChatSelection = ManagedTerminalChatScope & { target: CanonicalChatResourceReference };

export function managedTerminalChatTurn(
  options: ChatSubmitOptions,
  detail: CanonicalChatDetailResponse | null,
  chatId: string | undefined,
) {
  const selection = options.managedTerminalControl;
  if (!selection || !detail || !chatId || selection.chatId !== chatId || detail.record.chat.id !== chatId) return null;
  const { chat, activeRun } = detail.record;
  if (chat.ownerScope.type !== "personal" || chat.lifecycle !== "active" || activeRun
    || (chat.collaboration && chat.collaboration.mode !== "private")
    || options.interactionMode !== "default" || options.permissionMode !== "full_access"
    || options.projectSkillProjectId || options.resources?.some(resource => resource.kind === "terminal_session")) return null;

  const root = canonicalChatFileScope(detail);
  if (root.kind !== "project" || root.projectId !== selection.projectId || root.worktreeId !== selection.worktreeId) return null;
  const { target } = selection;
  const [workspaceId, tabId, ...rest] = target.id.split(":");
  const parsed = TerminalRefSchema.safeParse({ workspaceId, tabId });
  if (target.kind !== "terminal_session" || !target.revision || !/^[a-f0-9]{64}$/.test(target.revision)
    || rest.length || !parsed.success || !isManagedTerminalRef(parsed.data)) return null;
  return {
    parts: herdrControlParts(target),
    executionRoot: { kind: "worktree" as const, projectId: root.projectId, worktreeId: selection.worktreeId },
  };
}
