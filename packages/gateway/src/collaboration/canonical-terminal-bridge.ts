import { createHash } from "node:crypto";
import { TerminalGridSizeSchema, TerminalRefSchema, type TerminalRef, type TerminalWorkspace } from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { Kysely } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationTerminalMetadata } from "./terminal-dispatcher.js";

type TerminalRuntime = Pick<TerminalRuntimeSocketClient,
  "listWorkspaces" | "writeInput" | "terminateTab" | "attach">;
const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;
const ATTACH_TIMEOUT_MS = 5_000;

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

function identity(ref: TerminalRef, tabIncarnation: string, createdAt: string): { incarnation: string; generation: number } {
  if (!/^ti_[a-f0-9]{32}$/.test(tabIncarnation)) throw new CanonicalTerminalBridgeError();
  const generation = Date.parse(createdAt);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new CanonicalTerminalBridgeError();
  return {
    incarnation: `terminal-${createHash("sha256")
      .update("matrix-collaboration-terminal-v1\0")
      .update(`${ref.workspaceId}:${ref.tabId}:${tabIncarnation}`).digest("hex").slice(0, 32)}`,
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
    const tabIncarnation = tab.incarnation;
    if (!tabIncarnation || !/^ti_[a-f0-9]{32}$/.test(tabIncarnation)) throw new CanonicalTerminalBridgeError();
    const { incarnation, generation } = identity(ref, tabIncarnation, tab.createdAt);
    return { ref, tab, tabIncarnation, incarnation, generation };
  };

  const boundTab = async (scopeId: string, terminalId: string, incarnation: string) => {
    const binding = await db.selectFrom("collaboration_terminal_bindings")
      .selectAll().where("scope_id", "=", scopeId).where("terminal_id", "=", terminalId)
      .where("incarnation", "=", incarnation).executeTakeFirst();
    const current = await currentTab(terminalId);
    if (!binding || !current || current.incarnation !== binding.incarnation
      || current.generation !== Number(binding.execution_generation)
      || current.tabIncarnation !== binding.tab_incarnation
      || current.tab.createdAt !== new Date(binding.tab_created_at).toISOString()) {
      throw new CanonicalTerminalBridgeError();
    }
    return current;
  };

  return {
    connectOutput: async (metadata: CollaborationTerminalMetadata, handlers: {
      output(data: string): Promise<void>;
      exit(): Promise<void>;
      error(): void;
    }): Promise<{ close(): void }> => {
      if (metadata.status !== "active") throw new CanonicalTerminalBridgeError();
      const current = await boundTab(metadata.scopeId, metadata.terminalId, metadata.incarnation);
      if (current.generation !== metadata.executionGeneration) throw new CanonicalTerminalBridgeError();
      const workspaces = await runtime.listWorkspaces();
      const workspace = workspaces.find((item) => item.id === current.ref.workspaceId);
      const size = TerminalGridSizeSchema.safeParse(workspace?.canonicalSize);
      if (!size.success) throw new CanonicalTerminalBridgeError();
      let stream: ReturnType<TerminalRuntime["attach"]> | undefined;
      let closed = false;
      let attached = false;
      let pendingBytes = 0;
      let delivery = Promise.resolve();
      const close = () => {
        if (closed) return;
        closed = true;
        stream?.close();
      };
      const failed = (error?: unknown) => {
        if (error !== undefined) {
          console.warn("[canonical-terminal-bridge] output delivery failed", error instanceof Error ? error.name : "UnknownError");
        }
        if (closed) return;
        close();
        handlers.error();
      };
      const queueOutput = (data: string) => {
        const bytes = Buffer.byteLength(data);
        if (bytes > MAX_PENDING_OUTPUT_BYTES || pendingBytes + bytes > MAX_PENDING_OUTPUT_BYTES) {
          failed();
          return;
        }
        pendingBytes += bytes;
        delivery = delivery.then(async () => {
          if (!closed) await handlers.output(data);
        }).catch((error: unknown) => failed(error)).finally(() => { pendingBytes -= bytes; });
      };
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CanonicalTerminalBridgeError()), ATTACH_TIMEOUT_MS);
          timer.unref?.();
          const rejectAttach = () => {
            clearTimeout(timer);
            if (!attached) reject(new CanonicalTerminalBridgeError());
            else failed();
          };
          stream = runtime.attach({
            ref: current.ref,
            expectedIncarnation: current.tabIncarnation,
            viewerId: `collab:${metadata.scopeId}`,
            fromSeq: Number.MAX_SAFE_INTEGER,
            mode: "soft",
            size: size.data,
            onFrame(frame) {
              if (closed) return;
              if (frame.type === "attached") {
                attached = true;
                clearTimeout(timer);
                resolve();
              } else if (frame.type === "snapshot" || frame.type === "output") {
                if (!attached) { rejectAttach(); return; }
                queueOutput(frame.type === "snapshot" ? frame.ansi : frame.data);
              } else if (frame.type === "exit") {
                delivery = delivery.then(() => handlers.exit()).catch((error: unknown) => failed(error)).finally(close);
              }
            },
            onClose: rejectAttach,
            onError: rejectAttach,
          });
        });
      } catch (error: unknown) {
        close();
        throw error;
      }
      if (closed) throw new CanonicalTerminalBridgeError();
      return { close };
    },
    registry: {
      get: async (terminalId: string): Promise<unknown> => {
        const current = await currentTab(terminalId);
        if (!current) return null;
        const binding = await db.selectFrom("collaboration_terminal_bindings")
          .selectAll().where("terminal_id", "=", terminalId).executeTakeFirst();
        if (binding && (binding.incarnation !== current.incarnation
          || Number(binding.execution_generation) !== current.generation
          || binding.tab_incarnation !== current.tabIncarnation
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
          // The owner's opt-in is the only source of Contributor control; absent binding means withheld.
          contributorControl: binding ? binding.contributor_control === true : false,
        };
      },
      bindCollaboration: async (terminalId: string, input: {
        scopeId: string; sessionIncarnation: string; executionGeneration: number; contributorControl: boolean;
      }): Promise<unknown> => {
        // Absent is withheld: sharing never opts Contributors into the owner's host shell.
        const contributorControl = input.contributorControl === true;
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
            tab_incarnation: current.tabIncarnation,
            incarnation: current.incarnation,
            execution_generation: current.generation,
            contributor_control: contributorControl,
            created_at: new Date().toISOString(),
          }).onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
          const binding = await trx.selectFrom("collaboration_terminal_bindings")
            .selectAll().where("scope_id", "=", input.scopeId).executeTakeFirst();
          if (!binding || binding.terminal_id !== terminalId || binding.incarnation !== current.incarnation
            || binding.tab_incarnation !== current.tabIncarnation
            || Number(binding.execution_generation) !== current.generation) throw new CanonicalTerminalBridgeError();
          if (binding.contributor_control !== contributorControl) {
            // A replayed bind for the verified row carries the caller's opt-in forward inside this transaction.
            await trx.updateTable("collaboration_terminal_bindings")
              .set({ contributor_control: contributorControl })
              .where("scope_id", "=", input.scopeId).where("terminal_id", "=", terminalId)
              .where("incarnation", "=", current.incarnation).execute();
            return { ...binding, contributor_control: contributorControl };
          }
          return binding;
        });
      },
      /** The owner opts Contributors into host-shell control, or withdraws it, without unsharing the terminal. */
      setContributorControl: async (terminalId: string, input: {
        scopeId: string; sessionIncarnation: string; ownerId: string; contributorControl: boolean;
      }): Promise<unknown> => {
        if (input.ownerId !== ownerId) throw new CanonicalTerminalBridgeError();
        const contributorControl = input.contributorControl === true;
        const current = await boundTab(input.scopeId, terminalId, input.sessionIncarnation);
        if (current.tab.status !== "running" && current.tab.status !== "idle") {
          throw new CanonicalTerminalBridgeError();
        }
        const updated = await db.updateTable("collaboration_terminal_bindings")
          .set({ contributor_control: contributorControl })
          .where("scope_id", "=", input.scopeId).where("terminal_id", "=", terminalId)
          .where("incarnation", "=", input.sessionIncarnation).where("owner_id", "=", ownerId)
          .returningAll().executeTakeFirst();
        if (!updated) throw new CanonicalTerminalBridgeError();
        return updated;
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
        await runtime.writeInput(current.ref, input.data, current.tabIncarnation);
      },
      paste: async (input: {
        terminalId: string; scopeId: string; incarnation: string; data: string; revalidate(): Promise<void>;
      }): Promise<void> => {
        const current = await boundTab(input.scopeId, input.terminalId, input.incarnation);
        await input.revalidate();
        await runtime.writeInput(current.ref, input.data, current.tabIncarnation);
      },
      resize: async (): Promise<void> => { throw new CanonicalTerminalBridgeError(); },
      stop: async (input: { terminalId: string; scopeId: string; incarnation: string }): Promise<void> => {
        const current = await boundTab(input.scopeId, input.terminalId, input.incarnation);
        await runtime.terminateTab(current.ref, current.tabIncarnation);
      },
    },
  };
}
