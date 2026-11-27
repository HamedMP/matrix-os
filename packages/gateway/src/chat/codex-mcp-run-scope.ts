import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { z } from "zod/v4";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";
import {
  TerminalRefSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import { isHerdrChatTerminalRef, isTerminalControlCommand } from "@matrix-os/contracts/herdr-terminals";
import { MATRIX_MCP_LAUNCHER, type MatrixMcpCapabilityIssuer } from "./matrix-mcp-launch.js";
import { CodexTerminalMcpLeaseSchema } from "../coding-agents/codex-terminal-mcp.mjs";

export type CodexTerminalMcpLease = z.infer<typeof CodexTerminalMcpLeaseSchema>;
/** Resolve the explicit user action, never the task text or a generic terminal attachment. */
export function selectedHerdrTerminal(parts: CanonicalProviderRunInput["parts"]) {
  const invocations = parts.filter((part) => part.type === "invocation_reference");
  const command = invocations.length === 1 ? invocations[0]?.invocation : undefined;
  if (!isTerminalControlCommand(command)) return undefined;
  const resources = parts.flatMap((part) =>
    part.type === "resource_reference" && part.resource.kind === "terminal_session" ? [part.resource] : [],
  );
  const target = resources.length === 1 ? resources[0] : undefined;
  if (!target?.revision || !/^[0-9a-f]{64}$/.test(target.revision)) return undefined;
  const [workspaceId, tabId, ...rest] = target.id.split(":");
  const ref = TerminalRefSchema.safeParse({ workspaceId, tabId });
  if (rest.length || !ref.success || !isHerdrChatTerminalRef(ref.data)) return undefined;
  return { ref: ref.data, revision: target.revision };
}

/** Ephemeral direct HTTP admission. This property is never saved or forwarded from request JSON. */
export type HerdrDispatchRun = CanonicalChatRun & { ownerSubmittedHerdrTurn?: true; ownerSubmittedHerdrDiscovery?: true };
export function withOwnerHerdrAdmission(
  run: CanonicalChatRun,
  message: CanonicalChatMessage,
  owner: CanonicalOwnerScope,
  directOwnerTurn?: true,
): HerdrDispatchRun {
  if (
    !directOwnerTurn ||
    owner.type !== "personal" ||
    message.actorId !== owner.ownerId ||
    run.attempt !== 1 ||
    run.driverKind !== "codex" ||
    message.role !== "user" ||
    message.state !== "committed" ||
    message.purpose !== "ai_request" ||
    message.chatId !== run.chatId ||
    message.turnId !== run.turnId
  )
    return run;
  return selectedHerdrTerminal(message.parts)
    ? { ...run, ownerSubmittedHerdrTurn: true }
    : { ...run, ownerSubmittedHerdrDiscovery: true };
}

const executions = new AsyncLocalStorage<{
  ownerId: string;
  lease: CodexTerminalMcpLease;
  live(): boolean;
}>();
export const withoutNativeCodexMcpExecution = <T>(work: () => T) => executions.exit(work);

/** Host-only context, never a public Chat request field or transcript. */
export function nativeCodexMcpExecution(ownerId: string): CodexTerminalMcpLease | undefined {
  const source = executions.getStore();
  if (!source) return undefined;
  if (source.ownerId !== ownerId || !source.live()) throw new Error("Matrix MCP run unavailable");
  return source.lease;
}

/** The actual canonical private worktree Run owns and revokes its broker capability. */
export function createCodexMcpRunScope(
  options:
    | {
        issuer: MatrixMcpCapabilityIssuer;
        gatewayPort: number;
      }
    | undefined,
) {
  // <=64 active Runs; settled/aborted Runs evict themselves. The issuer also
  // applies its existing bounded capability TTL and shutdown drain.
  const active = new Map<string, { ownerId: string; chatId: string; close(): void }>();
  return {
    open(input: CanonicalProviderRunInput) {
      if (
        !options ||
        (!input.ownerSubmittedHerdrTurn && !input.ownerSubmittedHerdrDiscovery) ||
        input.owner.type !== "personal" ||
        input.sharedScopeId ||
        input.nativeScheduled ||
        input.continuationId
      )
        return undefined;
      const target = selectedHerdrTerminal(input.parts);
      const discoveryOnly = !target && input.ownerSubmittedHerdrDiscovery === true;
      const selected = target && input.ownerSubmittedHerdrTurn
        && input.interactionMode === "default" && input.permissionMode === "full_access"
        && input.worktreeId && input.executionRoot
        ? { chatId: input.chatId, worktreeId: input.worktreeId, executionRoot: input.executionRoot, ...target }
        : undefined;
      if (!selected && !discoveryOnly) return undefined;
      if (input.signal.aborted || active.size >= 64 || active.has(input.runId)) {
        if (discoveryOnly) return undefined;
        throw new Error("Matrix MCP run unavailable");
      }
      const capability = options.issuer.issue({
        owner: input.owner,
        runId: input.runId,
        ...(selected ? {
          scope: "chat_herdr" as const, fullAccess: true, herdr: selected,
        } : { scope: "chat_herdr_discovery" as const }),
      });
      if (!capability) {
        if (discoveryOnly) return undefined;
        throw new Error("Matrix MCP run unavailable");
      }
      let closed = false;
      let lease: CodexTerminalMcpLease;
      try {
        lease = CodexTerminalMcpLeaseSchema.parse({
          attemptId: randomUUID(),
          token: capability.token,
          gatewayPort: options.gatewayPort,
          launcher: MATRIX_MCP_LAUNCHER,
          ...(discoveryOnly ? { discoveryOnly: true } : {}),
        });
      } catch (error: unknown) {
        capability.revoke();
        throw error;
      }
      const row = {
        ownerId: input.owner.ownerId,
        chatId: input.chatId,
        close() {
          if (closed) return;
          closed = true;
          capability.revoke();
          input.signal.removeEventListener("abort", row.close);
          if (active.get(input.runId) === row) active.delete(input.runId);
        },
      };
      active.set(input.runId, row);
      input.signal.addEventListener("abort", row.close, { once: true });
      if (input.signal.aborted) row.close();
      return {
        lease,
        withContext: <T>(work: () => T) => {
          if (closed) throw new Error("Matrix MCP run unavailable");
          return executions.run(
            { ownerId: input.owner.ownerId, lease, live: () => !closed && !input.signal.aborted },
            work,
          );
        },
        close: row.close,
      };
    },
    cancel(input: { ownerId: string; chatId: string; runId: string }) {
      const row = active.get(input.runId);
      if (row?.ownerId === input.ownerId && row.chatId === input.chatId) row.close();
    },
  };
}
