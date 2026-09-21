import { createHash } from "node:crypto";
import { TerminalRefSchema, type TerminalRef, type TerminalWorkspace } from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { Kysely } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

type TerminalRuntime = Pick<TerminalRuntimeSocketClient,
  "listWorkspaces" | "writeInput" | "terminateTab">;

export class CanonicalTerminalBridgeError extends Error {
  constructor() {
    super("Shared terminal is unavailable");
    this.name = "CanonicalTerminalBridgeError";
  }
}

function parseTerminalId(value: string): TerminalRef {
  const [workspaceId, tabId, extra] = value.split(":");
  if (extra !== undefined) throw new CanonicalTerminalBridgeError();
  const parsed = TerminalRefSchema.safeParse({ workspaceId, tabId });
  if (!parsed.success) throw new CanonicalTerminalBridgeError();
  return parsed.data;
}

function identity(ref: TerminalRef, createdAt: string): { incarnation: string; generation: number } {
  const generation = Date.parse(createdAt);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new CanonicalTerminalBridgeError();
  return {
    incarnation: `terminal-${createHash("sha256")
      .update(`${ref.workspaceId}:${ref.tabId}:${createdAt}`).digest("hex").slice(0, 32)}`,
    generation,
  };
}

export function createCanonicalTerminalCollaborationBridge(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  ownerId: string;
  runtime: TerminalRuntime;
}) {
  const { db, ownerId, runtime } = options;
  if (!ownerId) throw new CanonicalTerminalBridgeError();

  const currentTab = async (terminalId: string) => {
    const ref = parseTerminalId(terminalId);
    const workspaces = await runtime.listWorkspaces();
    const workspace = workspaces.find((item: TerminalWorkspace) => item.id === ref.workspaceId);
    const tab = workspace?.tabs.find((item) => item.id === ref.tabId);
    if (!tab || tab.workspaceId !== ref.workspaceId) return null;
    const { incarnation, generation } = identity(ref, tab.createdAt);
    return { ref, tab, incarnation, generation };
  };

  const boundTab = async (scopeId: string, terminalId: string, incarnation: string) => {
    const binding = await db.selectFrom("collaboration_terminal_bindings")
      .selectAll().where("scope_id", "=", scopeId).where("terminal_id", "=", terminalId)
      .where("incarnation", "=", incarnation).executeTakeFirst();
    const current = await currentTab(terminalId);
    if (!binding || !current || current.incarnation !== binding.incarnation
      || current.generation !== Number(binding.execution_generation)
      || current.tab.createdAt !== new Date(binding.tab_created_at).toISOString()) {
      throw new CanonicalTerminalBridgeError();
    }
    return current;
  };

  return {
    registry: {
      get: async (terminalId: string): Promise<unknown> => {
        const current = await currentTab(terminalId);
        if (!current) return null;
        const binding = await db.selectFrom("collaboration_terminal_bindings")
          .selectAll().where("terminal_id", "=", terminalId).executeTakeFirst();
        if (binding && (binding.incarnation !== current.incarnation
          || Number(binding.execution_generation) !== current.generation
          || new Date(binding.tab_created_at).toISOString() !== current.tab.createdAt)) return null;
        const status = current.tab.status === "running" || current.tab.status === "idle" ? "active" : "exited";
        return {
          name: terminalId,
          status,
          createdAt: current.tab.createdAt,
          incarnationVerified: true,
          creatorActorId: ownerId,
          sessionIncarnation: current.incarnation,
          executionGeneration: current.generation,
          sharedControlMode: binding ? "shared" : "eligible",
          ...(binding ? { collaborationScopeId: binding.scope_id } : {}),
          contributorControl: true,
        };
      },
      bindCollaboration: async (terminalId: string, input: {
        scopeId: string; sessionIncarnation: string; executionGeneration: number;
      }): Promise<unknown> => {
        const current = await currentTab(terminalId);
        if (!current || (current.tab.status !== "running" && current.tab.status !== "idle")
          || current.incarnation !== input.sessionIncarnation
          || current.generation !== input.executionGeneration) throw new CanonicalTerminalBridgeError();
        return db.transaction().execute(async (trx) => {
          const scope = await trx.selectFrom("collaboration_scopes")
            .select(["owner_id", "kind", "resource_id", "lifecycle"])
            .where("id", "=", input.scopeId).forUpdate().executeTakeFirst();
          if (!scope || scope.owner_id !== ownerId || scope.kind !== "terminal"
            || scope.resource_id !== terminalId || scope.lifecycle !== "private") throw new CanonicalTerminalBridgeError();
          await trx.insertInto("collaboration_terminal_bindings").values({
            scope_id: input.scopeId,
            owner_id: ownerId,
            terminal_id: terminalId,
            workspace_id: current.ref.workspaceId,
            tab_id: current.ref.tabId,
            tab_created_at: current.tab.createdAt,
            incarnation: current.incarnation,
            execution_generation: current.generation,
            created_at: new Date().toISOString(),
          }).onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
          const binding = await trx.selectFrom("collaboration_terminal_bindings")
            .selectAll().where("scope_id", "=", input.scopeId).executeTakeFirst();
          if (!binding || binding.terminal_id !== terminalId || binding.incarnation !== current.incarnation
            || Number(binding.execution_generation) !== current.generation) throw new CanonicalTerminalBridgeError();
          return binding;
        });
      },
      unbindCollaboration: async (terminalId: string, input: {
        scopeId: string; sessionIncarnation: string;
      }): Promise<void> => {
        await db.deleteFrom("collaboration_terminal_bindings")
          .where("scope_id", "=", input.scopeId).where("terminal_id", "=", terminalId)
          .where("incarnation", "=", input.sessionIncarnation).execute();
      },
    },
    runtime: {
      input: async (input: {
        terminalId: string; scopeId: string; incarnation: string; data: string; revalidate(): Promise<void>;
      }): Promise<void> => {
        const current = await boundTab(input.scopeId, input.terminalId, input.incarnation);
        await input.revalidate();
        await runtime.writeInput(current.ref, input.data, current.tab.createdAt);
      },
      paste: async (input: {
        terminalId: string; scopeId: string; incarnation: string; data: string; revalidate(): Promise<void>;
      }): Promise<void> => {
        const current = await boundTab(input.scopeId, input.terminalId, input.incarnation);
        await input.revalidate();
        await runtime.writeInput(current.ref, input.data, current.tab.createdAt);
      },
      resize: async (): Promise<void> => { throw new CanonicalTerminalBridgeError(); },
      stop: async (input: { terminalId: string; scopeId: string; incarnation: string }): Promise<void> => {
        const current = await boundTab(input.scopeId, input.terminalId, input.incarnation);
        await runtime.terminateTab(current.ref, current.tab.createdAt);
      },
    },
  };
}
