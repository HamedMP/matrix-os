/** Exact approvals stay in gateway/owner Postgres, never in model arguments. */
import { createHash } from "node:crypto";
import type { BotToolRequest, GithubDeveloperAction } from "@matrix-os/contracts";
import type { BotStateTransactions } from "./events.js";
import { BotBrokerActionError } from "./broker-actions.js";
import { isManagedPiBinding, type PiRuntimeBinding, type ManagedPiRuntimeBinding } from "./runtime-registry.js";
import { createBotApprovalsRepository } from "./repositories/approvals.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { BotStateError } from "./repositories/shared.js";
import type { GithubDeveloperPlan, GithubDeveloperService } from "./github-developer-service.js";

type Request = Extract<BotToolRequest, { capability: "github.developer" }>;
const TOOL = "github.developer";
const TTL = 10 * 60_000;
const MAX_RECEIPTS = 3840; // 64 admitted runs x 60 bounded broker actions.
function digest(binding: PiRuntimeBinding, args: GithubDeveloperAction, plan: GithubDeveloperPlan) {
  return createHash("sha256").update(JSON.stringify({ args, plan, root: binding.rootFingerprint,
    owner: binding.ownerId, chat: binding.chatId, definition: binding.managedDefinitionRevision ?? 1 })).digest("hex");
}
function identity(binding: PiRuntimeBinding, request: Request) {
  return `${binding.runtimeHandle}:${binding.executionGeneration}:${binding.runId}:${request.toolCallId}`;
}

export function createBotGithubDeveloperTools(deps: {
  service: GithubDeveloperService;
  transact: BotStateTransactions;
  authorizeManaged(binding: ManagedPiRuntimeBinding, request: Request, plan: GithubDeveloperPlan, signal: AbortSignal): Promise<void>;
  now?: () => Date;
}) {
  const now = () => deps.now?.() ?? new Date();
  const receipts = new Map<string, { hash: string; plan: GithubDeveloperPlan; runId: string; expiresAt: number }>();
  function sweep() { for (const [key, receipt] of receipts) if (receipt.expiresAt <= now().getTime()) receipts.delete(key); }
  function validate(binding: PiRuntimeBinding) {
    if (binding.group || binding.requestClass !== "interactive" || !binding.capabilities.includes(TOOL)) throw new BotBrokerActionError("not_granted");
  }
  async function authorizeBot(binding: Exclude<PiRuntimeBinding, ManagedPiRuntimeBinding>, request: Request, plan: GithubDeveloperPlan) {
    if (request.args.action === "status") return;
    const account = plan.account;
    const argsHash = digest(binding, request.args, plan);
    const policy = { taskId: binding.taskId, tool: TOOL, argsHash, account, audience: "direct", policyRevision: 1 };
    const at = now();
    const granted = await deps.transact(binding.ownerId, async tx => {
      const approvals = createBotApprovalsRepository(tx.db);
      const prior = await approvals.findOpen({ ownerId: binding.ownerId, taskId: binding.taskId, tool: TOOL, argsHash, now: at.toISOString() }, tx.db);
      if (prior?.status === "denied") return "denied";
      if (prior?.status === "approved") {
        const claimed = await approvals.claim({ ...policy, ownerId: binding.ownerId, approvalId: prior.approvalId, now: at.toISOString() }, tx.db);
        return claimed.status === "claimed" ? "approved" : "denied";
      }
      if (prior?.status === "pending") return "pending";
      try {
        const { interaction } = await createBotInteractionsRepository(tx.db).create({
          ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, taskId: binding.taskId,
          kind: "approval", payload: { kind: "approval", tool: TOOL, argsDigest: argsHash, audience: "direct", policyRevision: 1,
            preview: `GitHub account: ${account}\nRepository: ${plan.repository ?? "none"}\nBranch: ${plan.branch ?? "none"}\n${plan.author ? `Author: ${plan.author.name} <${plan.author.email}>\n` : ""}${JSON.stringify(request.args)}` },
          sourceRunId: binding.runId, responderActorId: binding.ownerId, blocking: true,
          expiresAt: new Date(at.getTime() + TTL).toISOString(), now: at.toISOString(),
        }, tx.db);
        await approvals.create({ ...policy, ownerId: binding.ownerId, approvalId: interaction.interactionId, botId: binding.botId,
          runId: binding.runId, expiresAt: interaction.expiresAt, now: at.toISOString() }, tx.db);
        await tx.publish(binding.chatId, "interaction.requested", { interactionId: interaction.interactionId, chatId: binding.chatId,
          agentId: binding.botId, kind: "approval", blocking: true, expiresAt: interaction.expiresAt, revision: interaction.revision });
      } catch (error: unknown) {
        if (!(error instanceof BotStateError && error.code === "conflict")) throw error;
      }
      return "pending";
    });
    if (granted !== "approved") throw new BotBrokerActionError(granted === "denied" ? "denied" : "approval_required");
  }
  return {
    async prepare(binding: PiRuntimeBinding, root: string, request: Request, signal: AbortSignal) {
      validate(binding); sweep();
      if (receipts.size >= MAX_RECEIPTS || receipts.has(identity(binding, request))) throw new BotBrokerActionError("denied");
      // Status remains useful before login and does not touch repository data.
      const plan = request.args.action === "status" ? { account: "status" } : await deps.service.inspect(root, request.args, signal);
      if (isManagedPiBinding(binding)) await deps.authorizeManaged(binding, request, plan, signal);
      else await authorizeBot(binding, request, plan);
      if (signal.aborted) throw new BotBrokerActionError("stale_generation");
      receipts.set(identity(binding, request), { hash: digest(binding, request.args, plan), plan, runId: binding.runId, expiresAt: now().getTime() + TTL });
    },
    async dispatch(binding: PiRuntimeBinding, root: string, request: Request, signal: AbortSignal, assertCurrent: () => Promise<void>) {
      validate(binding); sweep();
      const key = identity(binding, request);
      const receipt = receipts.get(key); receipts.delete(key);
      if (!receipt || receipt.hash !== digest(binding, request.args, receipt.plan)) throw new BotBrokerActionError("denied");
      await assertCurrent();
      const result = await deps.service.execute(root, request.args, signal, request.args.action === "status" ? undefined : { plan: receipt.plan, assertCurrent });
      return { ok: true as const, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
    closeRun(runId: string) { for (const [key, receipt] of receipts) if (receipt.runId === runId) receipts.delete(key); },
  };
}
export type BotGithubDeveloperTools = ReturnType<typeof createBotGithubDeveloperTools>;
