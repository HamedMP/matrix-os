/** Production probes for the owner home's single readiness projection. */
import type { ReadinessProbes, ReadinessSubject } from "./readiness-evaluator.js";
import type { CollaborationRepository } from "./repository.js";
import type { ProjectInventoryResourceSource } from "./project-inventory.js";
import type { ChatRepository } from "../chat/repository.js";

interface Options {
  repository: Pick<CollaborationRepository, "getScope">;
  chats: Pick<ChatRepository, "kysely">;
  projectSource: () => Pick<ProjectInventoryResourceSource, "listChats" | "getGitSetup"> | undefined;
  sharedAiAvailable(): boolean;
  ownerSource: Pick<ReadinessProbes, "aiSource" | "submitMode"> | undefined;
}

export function createGatewayReadinessProbes(options: Options): ReadinessProbes {
  async function projectId(subject: ReadinessSubject): Promise<string | null> {
    const scope = await options.repository.getScope(subject.scopeId);
    if (!scope || scope.ownerId !== subject.ownerId || scope.organizationId !== subject.organizationId) {
      throw new Error("ReadinessScopeUnavailable");
    }
    if (subject.resourceKind === "project") return scope.resourceId;
    if (subject.resourceKind !== "chat") return null;
    const chat = await options.chats.kysely.selectFrom("chats")
      .select("project_id")
      .where("id", "=", scope.resourceId)
      .where("owner_type", "=", "personal")
      .where("owner_id", "=", subject.ownerId)
      .executeTakeFirst();
    if (!chat) throw new Error("ReadinessChatUnavailable");
    return chat.project_id;
  }

  async function gitSetup(subject: ReadinessSubject) {
    const id = await projectId(subject);
    if (!id) return null;
    const source = options.projectSource();
    if (!source?.getGitSetup) throw new Error("ReadinessGitSetupUnavailable");
    return source.getGitSetup(subject.ownerId, id);
  }

  return {
    async hostOnline() { return true; },
    async supported(subject) {
      return subject.resourceKind !== "project" && subject.resourceKind !== "chat"
        ? true : options.sharedAiAvailable();
    },
    async aiSource(subject) {
      return options.ownerSource?.aiSource(subject) ?? { configured: false };
    },
    async submitMode(subject) {
      return options.ownerSource?.submitMode(subject) ?? "owner_only";
    },
    async gitIdentity(subject) {
      const setup = await gitSetup(subject);
      if (!setup) return { configured: true }; // Rootless standalone Chat has no Git dependency.
      return { configured: setup.identity.status === "ready", ...(setup.identity.label ? { label: setup.identity.label } : {}) };
    },
    async forgeCredential(subject) {
      const setup = await gitSetup(subject);
      return { configured: !setup || setup.forgeCredential.status === "ready" };
    },
    async chatRootInventory(subject) {
      const id = await projectId(subject);
      if (!id) return { chatRootCount: 0, dirtyRootCount: 0, unresolved: 0 };
      const source = options.projectSource();
      if (!source) throw new Error("ReadinessChatRootsUnavailable");
      const all = await source.listChats(subject.ownerId, id);
      const scope = await options.repository.getScope(subject.scopeId);
      if (!scope) throw new Error("ReadinessScopeUnavailable");
      const chats = subject.resourceKind === "chat" ? all.filter((chat) => chat.id === scope.resourceId) : all;
      return {
        chatRootCount: chats.length,
        dirtyRootCount: chats.filter((chat) => chat.dirty === true).length,
        unresolved: chats.filter((chat) => chat.compatibility !== "ready").length,
      };
    },
  };
}
