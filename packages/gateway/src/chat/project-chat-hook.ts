/**
 * Hook the project board registers with the chat repository (spec 2699, "Every
 * task is a chat"). The repository calls it inside the transaction that writes
 * a chat, so a project chat and its task commit or roll back together, whatever
 * path created or changed the chat.
 */
import type { Kysely, Transaction } from "kysely";
import type { CanonicalOwnerScope } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";

export type ProjectChatExecutor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

export interface ProjectChatSnapshot {
  id: string;
  projectId: string | null;
  title: string;
  lifecycle: "active" | "archived";
}

export interface ProjectChatHook {
  /** A chat was inserted. `ticket` is the caller's task seed (a board create), or undefined for a plain chat. */
  created(trx: ProjectChatExecutor, owner: CanonicalOwnerScope, chat: ProjectChatSnapshot, ticket: unknown): Promise<void>;
  /** A chat's title, project or lifecycle changed. */
  updated(trx: ProjectChatExecutor, owner: CanonicalOwnerScope, before: ProjectChatSnapshot, after: ProjectChatSnapshot): Promise<void>;
  /** A chat is about to be deleted. */
  deleted(trx: ProjectChatExecutor, owner: CanonicalOwnerScope, chatId: string): Promise<void>;
}

export function projectChatSnapshot(row: { id: string; project_id: string | null; title: string; lifecycle: "active" | "archived" }): ProjectChatSnapshot {
  return { id: row.id, projectId: row.project_id, title: row.title, lifecycle: row.lifecycle };
}

/** Whether a change touches what the board mirrors. */
export function projectChatChanged(before: ProjectChatSnapshot, after: ProjectChatSnapshot): boolean {
  return before.projectId !== after.projectId || before.title !== after.title || before.lifecycle !== after.lifecycle;
}
