import type { CanonicalOwnerScope } from "@matrix-os/contracts";
import { BoundedActionJsonSchema, CanonicalExecutionPolicySchema, type CanonicalExecutionPolicy, type CanonicalOperation } from "@matrix-os/contracts";
import { normalizedArgumentDigest, canonicalJsonStringify } from "./argument-digest.js";
import { ActionRepository, CanonicalActionError, type ActionIdentity, type ActionDecision } from "./action-repository.js";
import type { ActionQualificationInput } from "./action-policy.js";
import type { CanonicalActionTool, QualifiedActionTool } from "./action-tools.js";
import type { CanonicalProviderRunEvent } from "./provider-adapter.js";
export interface CanonicalActionInvocation {
  owner: CanonicalOwnerScope; chatId: string; runId: string; actionId: string; toolId: string;
  arguments: unknown; executionPolicy: CanonicalExecutionPolicy; signal: AbortSignal;
}
/** Frozen contract shared by typed, spoken and qualified delegated adapters. No client authority flags. */
export interface CanonicalActionAuthority {
  qualify(input: ActionQualificationInput): Promise<{ executionPolicy: CanonicalExecutionPolicy; tools: QualifiedActionTool[] }>;
  invoke(input: CanonicalActionInvocation): Promise<unknown>;
  decide(input: ActionDecision): Promise<CanonicalOperation>;
  cancel(input: ActionIdentity): Promise<CanonicalOperation>;
  cancelById(input: { owner: CanonicalOwnerScope; chatId: string; actionId: string }): Promise<CanonicalOperation>;
  reconcile(input: ActionIdentity): Promise<CanonicalOperation>;
  reconcilePending(): Promise<{ checked: number; resolved: number; uncertain: number }>;
}
export function createCanonicalActionAuthority(options: {
  repository: ActionRepository;
  tools: readonly CanonicalActionTool[];
  qualifyPolicy(input: ActionQualificationInput): Promise<CanonicalExecutionPolicy | undefined>;
  /** Must persist through canonical orchestrator activities; failures prevent dispatch. */
  onEvent(identity: ActionIdentity, event: CanonicalProviderRunEvent): Promise<void>;
  timeoutMs?: number;
}): CanonicalActionAuthority {
  const { repository } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (options.tools.length > 32 || new Set(options.tools.map((t) => t.toolId)).size !== options.tools.length || timeoutMs < 1 || timeoutMs > 300_000) throw new CanonicalActionError();
  const inventory = options.tools.map((tool) => Object.freeze({ ...tool, inputSchema: structuredClone(tool.inputSchema) }));
  const toolFor = (id: string) => { const tool = inventory.find((t) => t.toolId === id); if (!tool) throw new CanonicalActionError(); return tool; };
  const authority: CanonicalActionAuthority = {
    async qualify(input) {
      const executionPolicy = CanonicalExecutionPolicySchema.parse(await options.qualifyPolicy(input));
      if (executionPolicy.workspaceScope !== input.workspaceScope || executionPolicy.delegation || !/^apps(?::[a-z0-9][a-z0-9-]{0,63})?$/.test(executionPolicy.workspaceScope)) throw new CanonicalActionError();
      const tools = executionPolicy.tools.map((id) => {
        const { toolId, schemaRevision, description, inputSchema, effect, approval, reconciliation, cancellation } = toolFor(id);
        if (executionPolicy.actionMode === "conversation_only" || executionPolicy.actionMode === "safe_reads" && (effect === "files" || effect === "data") || effect === "files" && (!approval || !reconciliation) || effect === "data" && !reconciliation) throw new CanonicalActionError();
        return { toolId, schemaRevision, description, inputSchema, effect, approval, reconciliation, cancellation };
      });
      return { executionPolicy, tools };
    },
    async invoke(input) {
      const identity: ActionIdentity = { ...input, actionId: input.actionId };
      await repository.verify(identity, input.executionPolicy);
      const tool = toolFor(input.toolId);
      if (!input.executionPolicy.tools.includes(tool.toolId) || input.executionPolicy.actionMode === "conversation_only" || input.executionPolicy.actionMode === "safe_reads" && (tool.effect === "files" || tool.effect === "data")) throw new CanonicalActionError();
      if (tool.effect === "files" && (!tool.approval || !tool.reconciliation || !tool.reconcile)) throw new CanonicalActionError();
      if (tool.effect === "data" && (!tool.reconciliation || !tool.reconcile)) throw new CanonicalActionError();
      const args = BoundedActionJsonSchema.parse(tool.normalize(input.arguments));
      const scope = input.executionPolicy.workspaceScope;
      const app = (args as { app?: string }).app;
      if (scope !== "apps" && (typeof app !== "string" || scope !== `apps:${app}`)) throw new CanonicalActionError();
      const now = new Date().toISOString();
      let op = await repository.propose({ id: input.actionId, owner: input.owner, chatId: input.chatId, runId: input.runId, toolId: tool.toolId, schemaRevision: tool.schemaRevision, executionPolicy: input.executionPolicy, policyRevision: input.executionPolicy.revision, workspaceScope: input.executionPolicy.workspaceScope, arguments: args, argumentDigest: normalizedArgumentDigest(args), state: tool.approval ? "waiting_for_approval" : "authorized", revision: 0, cancellationRequested: false, createdAt: now, updatedAt: now });
      if (op.state === "succeeded") return op.result;
      // No ambiguous or running operation may be resubmitted, even by the same provider call.
      if (["running", "outcome_unknown", "failed", "cancelled", "timed_out"].includes(op.state)) throw new CanonicalActionError();
      if (op.state === "waiting_for_approval") {
        await options.onEvent(identity, { type: "approval.requested", approvalId: op.id, title: "Apply app files", risk: "medium", safeDescription: `App ${app ?? ""}: ${(args as { files?: Array<{ path: string; expectedSha256: string | null }> }).files?.map((file) => `${file.path.slice(0, 80)} (${file.expectedSha256 === null ? "create" : "replace exact hash"})`).join(", ") ?? "bounded files"}. Approval binds the exact normalized batch and policy.`.slice(0, 4_000), argumentDigest: op.argumentDigest, allowedDecisions: ["approve", "decline", "cancel"] });
        const deadline = Date.now() + timeoutMs;
        while (op.state === "waiting_for_approval" && !input.signal.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
          op = await repository.get(identity);
        }
        if (op.state === "waiting_for_approval") {
          op = await repository.transition(op, { state: input.signal.aborted ? "cancelled" : "timed_out", cancellationRequested: input.signal.aborted });
        }
      }
      if (input.signal.aborted) { await authority.cancel(identity); throw new CanonicalActionError(); }
      const qualified = await authority.qualify(await repository.qualificationInput(identity));
      if (canonicalJsonStringify(qualified.executionPolicy) !== canonicalJsonStringify(op.executionPolicy) || tool.schemaRevision !== op.schemaRevision || normalizedArgumentDigest(tool.normalize(op.arguments)) !== op.argumentDigest) throw new CanonicalActionError();
      const claim = await repository.claim(op);
      if (!claim) throw new CanonicalActionError();
      await options.onEvent(identity, { type: "tool.progress", toolCallId: op.id, label: tool.toolId, status: "running" });
      const beforeEffect = await repository.get(identity);
      if (beforeEffect.cancellationRequested || input.signal.aborted) {
        await repository.transition(beforeEffect, { state: "cancelled", cancellationRequested: true });
        throw new CanonicalActionError();
      }
      const controller = new AbortController();
      const aborted = () => controller.abort(); input.signal.addEventListener("abort", aborted, { once: true });
      if (input.signal.aborted) controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Effects are outside DB transactions. A timeout cannot prove a file commit did not occur.
        const result = await Promise.race([
          tool.execute({ owner: input.owner, actionId: op.id, arguments: args, signal: controller.signal }).then((value) => BoundedActionJsonSchema.parse(value)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CanonicalActionError()); }, timeoutMs); }),
        ]);
        const current = await repository.get(identity);
        op = await repository.transition(current, { state: "succeeded", result });
        await options.onEvent(identity, { type: "tool.progress", toolCallId: op.id, label: tool.toolId, status: "completed" });
        // Raw app data is returned to the model, never copied into public-safe
        // activity text. The operation view separately projects allowed fields.
        await options.onEvent(identity, { type: "tool.output", toolCallId: op.id, text: "Tool returned a result.", truncated: false });
        return result;
      } catch (error: unknown) {
        console.warn("[chat/actions] execution outcome unresolved", error instanceof Error ? error.name : "UnknownError");
        const current = await repository.get(identity);
        if (current.state !== "succeeded") await repository.transition(current, { state: tool.effect === "files" || tool.effect === "data" ? "outcome_unknown" : input.signal.aborted ? "cancelled" : "failed" });
        throw new CanonicalActionError();
      } finally { if (timer) clearTimeout(timer); input.signal.removeEventListener("abort", aborted); }
    },
    async decide(input) {
      const op = await repository.decide(input);
      await options.onEvent(input, { type: "approval.resolved", approvalId: op.id, decision: input.decision });
      return op;
    },
    async cancel(input) {
      // CAS-retry loop: a lost race means a concurrent write landed, so the
      // re-read row can carry neither our flag nor a terminal state. States
      // are monotone — bounded retries converge on terminal or our recorded
      // request, and the caller must map only an actually-set flag to
      // "requested".
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const op = await repository.get(input);
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(op.state)) return op;
        if (op.cancellationRequested) return op;
        const applied = await repository.tryTransition(op, {
          cancellationRequested: true,
          state: ["running", "outcome_unknown"].includes(op.state) ? op.state : "cancelled",
        });
        if (applied === null) continue;
        if (applied.state === "cancelled") {
          // Durable audit: a pre-dispatch cancel leaves no tool.output, so the
          // activity rail records the cancelled terminal explicitly. Emitted
          // only when this request's own write landed — a losing CAS never
          // projects a cancelled trace it did not cause. Best-effort: the
          // operation row is the authority and cancels may target older runs.
          await options.onEvent(input, { type: "tool.progress", toolCallId: applied.id, label: applied.toolId, status: "cancelled" }).catch((error: unknown) => {
            console.warn("[chat/actions] cancel activity projection failed", error instanceof Error ? error.name : "UnknownError");
          });
        }
        return applied;
      }
      return repository.get(input);
    },
    async cancelById(input) {
      return authority.cancel(await repository.identityFor(input));
    },
    async reconcile(input) {
      const op = await repository.get(input);
      if (!["running", "outcome_unknown"].includes(op.state)) return op;
      const tool = toolFor(op.toolId);
      if (tool.schemaRevision !== op.schemaRevision || !tool.reconcile) return repository.transition(op, { state: "outcome_unknown" });
      try {
        const evidence = await tool.reconcile({ owner: op.owner, actionId: op.id, arguments: op.arguments, signal: AbortSignal.timeout(10_000) });
        return repository.transition(op, evidence.confirmed ? { state: "succeeded", result: BoundedActionJsonSchema.parse(evidence.result) } : { state: "outcome_unknown" });
      } catch (error: unknown) {
        console.warn("[chat/actions] reconciliation uncertain", error instanceof Error ? error.name : "UnknownError");
        return repository.transition(op, { state: "outcome_unknown" });
      }
    },
    async reconcilePending() {
      const pending = await repository.listRecoverable();
      let resolved = 0;
      let uncertain = 0;
      for (const identity of pending) {
        try {
          const operation = await authority.reconcile(identity);
          if (operation.state === "succeeded") resolved += 1;
          else uncertain += 1;
        } catch (error: unknown) {
          uncertain += 1;
          console.warn("[chat/actions] recovery reconciliation failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return { checked: pending.length, resolved, uncertain };
    },
  };
  return Object.freeze(authority);
}
