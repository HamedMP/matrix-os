/** Gateway-only owner tools. No recipe identity or bearer reaches the Pi worker. */
import { randomUUID } from "node:crypto";
import type { BotToolCapability, BotToolRequest, BotToolResult, CanonicalChatApprovalDecision, CanonicalOwnerScope } from "@matrix-os/contracts";
import type { BotIntegrationClient, BotIntegrationConnection } from "../bots/integration-client.js";
import { BotBrokerActionError } from "../bots/broker-actions.js";
import type { ManagedPiRuntimeBinding } from "../bots/runtime-registry.js";
import { getService } from "../integrations/registry.js";
import { validateActionParams } from "../integrations/parameter-validation.js";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import { CALL_TOOL, createClaudeCustomMcpApprovalControl } from "./claude-custom-mcp-approval.js";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";
import type { ManagedPiMcpClient } from "./managed-pi-mcp-client.js";

const MAX_RUNS = 64;
const MAX_ACTIONS = 60;
const MAX_RESULT_BYTES = 192 * 1024;
const HUMAN_WAIT_MS = 10 * 60_000;
type Submit = { owner: CanonicalOwnerScope; chatId: string; runId: string; approvalId: string; decision: CanonicalChatApprovalDecision; clientRequestId: string; platformApprovalProof?: string };
type McpControl = ReturnType<typeof createClaudeCustomMcpApprovalControl>;
type Prepared = { args: string; account?: BotIntegrationConnection; receipt?: string };
interface Run {
  binding: ManagedPiRuntimeBinding;
  emit(event: CanonicalProviderRunEvent): void;
  controller: AbortController;
  prepared: Map<string, Prepared>; // <=60 actions, erased on close.
  seen: Set<string>; // <=60 actions, erased on close.
  pending?: { id: string; resolve(decision: CanonicalChatApprovalDecision): void };
  mcp?: McpControl;
  mcpInitialization?: Promise<McpControl>;
  revoking?: Promise<boolean>;
  generation?: number;
}
function text(value: unknown): BotToolResult {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw new Error("Tool result exceeds limit");
  const content: Array<{ type: "text"; text: string }> = [];
  for (let i = 0; i < Math.max(1, encoded.length); i += 60 * 1024) content.push({ type: "text", text: encoded.slice(i, i + 60 * 1024) });
  return { ok: true, content };
}
export function createManagedPiOwnerTools(deps: {
  authority(binding: ManagedPiRuntimeBinding): Promise<{ permissionMode: string }>;
  signalFor(binding: ManagedPiRuntimeBinding): AbortSignal | null;
  integrations?: Pick<BotIntegrationClient, "inventory" | "describe" | "call">;
  mcp?: ManagedPiMcpClient;
  approvals?: CustomMcpApprovalClient;
}) {
  const runs = new Map<string, Run>(); // capacity64, close on terminal/cancel; run deadline bounds lifetime.
  const capabilities: BotToolCapability[] = [
    ...(deps.integrations ? ["integration.inventory", "integration.describe", "integration.call"] as const : []),
    ...(deps.mcp && deps.approvals ? ["mcp.inventory", "mcp.describe", "mcp.call"] as const : []),
  ];
  function revoke(run: Run): Promise<boolean> {
    if (!run.generation) return Promise.resolve(false);
    return run.revoking ??= deps.approvals!.revokeRun(run.binding.runId);
  }
  function initializeMcp(run: Run): Promise<McpControl> {
    return run.mcpInitialization ??= (async () => {
      const registered = await deps.approvals!.registerRun(run.binding.runId);
      run.generation = registered.generation;
      const owned = deps.signalFor(run.binding);
      if (run.controller.signal.aborted || !owned || owned.aborted) {
        await revoke(run);
        throw new BotBrokerActionError("stale_generation");
      }
      run.mcp = createClaudeCustomMcpApprovalControl({ runId: run.binding.runId, generation: registered.generation,
        client: deps.approvals!, emit: run.emit, onError: error => console.warn("[managed-pi] MCP approval failed", error instanceof Error ? error.name : "UnknownError") });
      return run.mcp;
    })();
  }
  async function live(binding: ManagedPiRuntimeBinding, signal: AbortSignal) {
    const run = runs.get(binding.runId);
    const owned = deps.signalFor(binding);
    if (!run || run.binding.ownerId !== binding.ownerId || run.binding.chatId !== binding.chatId
      || run.binding.runtimeHandle !== binding.runtimeHandle || run.binding.executionGeneration !== binding.executionGeneration
      || !owned || owned.aborted || signal.aborted || run.controller.signal.aborted) throw new BotBrokerActionError("stale_generation");
    const authority = await deps.authority(binding);
    if (!["full_access", "supervised"].includes(authority.permissionMode) || signal.aborted || owned.aborted) throw new BotBrokerActionError("denied");
    return { run, permissionMode: authority.permissionMode,
      signal: AbortSignal.any([signal, owned, run.controller.signal]) };
  }
  async function account(binding: ManagedPiRuntimeBinding, args: Extract<BotToolRequest, { capability: "integration.call" }>["args"], signal: AbortSignal) {
    const rows = await deps.integrations!.inventory(binding.ownerId, signal);
    const chosen = rows.filter(row => row.service === args.service && row.connectionId === args.connectionId);
    if (chosen.length !== 1 || rows.filter(row => row.service === args.service && row.label === chosen[0]!.label).length !== 1) throw new BotBrokerActionError("not_granted");
    return chosen[0]!;
  }
  async function described(binding: ManagedPiRuntimeBinding, serviceId: string, permissionMode: string, signal: AbortSignal) {
    const service = getService(serviceId);
    if (!service || !deps.integrations) throw new BotBrokerActionError("invalid_arguments");
    const available = await deps.integrations.describe(binding.ownerId, { service: serviceId, readOnly: permissionMode !== "full_access" }, signal);
    return available.flatMap(remote => {
      const reviewed = service.actions[remote.id];
      if (!reviewed || remote.risk !== reviewed.risk || (permissionMode !== "full_access" && reviewed.risk !== "read")) return [];
      const params = Object.fromEntries(Object.entries(reviewed.params).filter(([name, param]) => remote.params[name]?.type === param.type));
      if (Object.entries(reviewed.params).some(([name, param]) => param.required && !Object.hasOwn(params, name))) return [];
      return [{ id: remote.id, description: reviewed.description, risk: reviewed.risk, params }];
    });
  }
  async function actionFor(binding: ManagedPiRuntimeBinding, args: Extract<BotToolRequest, { capability: "integration.call" }>["args"], permissionMode: string, signal: AbortSignal) {
    const matches = (await described(binding, args.service, permissionMode, signal)).filter(action => action.id === args.action);
    const reviewed = getService(args.service)?.actions[args.action];
    if (matches.length !== 1 || !reviewed || !validateActionParams(reviewed, args.params).valid
      || Object.keys(args.params).some(key => !Object.hasOwn(matches[0]!.params, key))) throw new BotBrokerActionError("invalid_arguments");
    return reviewed;
  }
  async function ask(run: Run, request: BotToolRequest, selected: BotIntegrationConnection, signal: AbortSignal): Promise<void> {
    const description = `Account ${selected.label} (${selected.connectionId})\n${JSON.stringify(request.args)}`;
    if (description.length > 4000 || run.pending) throw new BotBrokerActionError("invalid_arguments");
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (approved: boolean, decision: CanonicalChatApprovalDecision) => {
        if (run.pending?.id !== id) return;
        run.pending = undefined; clearTimeout(timer); signal.removeEventListener("abort", abort);
        run.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.resolved", approvalId: id, decision }));
        if (approved) resolve(); else reject(new BotBrokerActionError("denied"));
      };
      const abort = () => finish(false, "cancel");
      const timer = setTimeout(abort, HUMAN_WAIT_MS); timer.unref?.();
      run.pending = { id, resolve: decision => finish(decision === "approve", decision) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      run.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.requested", approvalId: id,
        title: "Allow this connected service action?", safeDescription: description, risk: "high", allowedDecisions: ["approve", "decline", "cancel"] }));
    });
  }
  async function prepare(binding: ManagedPiRuntimeBinding, request: BotToolRequest, callerSignal: AbortSignal): Promise<void> {
    const { run, permissionMode, signal } = await live(binding, callerSignal);
    if (!capabilities.includes(request.capability) || !binding.capabilities.includes(request.capability)) throw new BotBrokerActionError("not_granted");
    if (run.seen.has(request.toolCallId) || run.seen.size >= MAX_ACTIONS) throw new BotBrokerActionError("denied");
    run.seen.add(request.toolCallId);
    const prepared: Prepared = { args: JSON.stringify(request.args) };
    if (request.capability === "integration.call") {
      const action = await actionFor(binding, request.args, permissionMode, signal);
      if (action.risk !== "read" && permissionMode !== "full_access") throw new BotBrokerActionError("denied");
      prepared.account = await account(binding, request.args, signal);
      if (action.risk !== "read") await ask(run, request, prepared.account, signal);
    } else if (request.capability === "mcp.call") {
      if (permissionMode !== "full_access" || !deps.approvals) throw new BotBrokerActionError("denied");
      const control = await initializeMcp(run);
      prepared.receipt = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); control.onToolPermissionCancel(request.toolCallId); reject(new BotBrokerActionError("denied")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        control.onToolPermission({ nativeRequestId: request.toolCallId, toolName: CALL_TOOL,
          input: { server_id: request.args.serverId, tool: request.args.tool, arguments: request.args.arguments } }, async value => {
          signal.removeEventListener("abort", abort);
          const response = value as { behavior?: string; updatedInput?: { approval_receipt?: string } };
          if (response.behavior !== "allow" || signal.aborted) reject(new BotBrokerActionError("denied"));
          else resolve(response.updatedInput?.approval_receipt);
        });
      });
    }
    await live(binding, signal);
    run.prepared.set(request.toolCallId, prepared);
  }
  return {
    capabilities,
    async open(binding: ManagedPiRuntimeBinding, emit: Run["emit"]) {
      if (runs.has(binding.runId) || runs.size >= MAX_RUNS) throw new BotBrokerActionError("unavailable");
      const run: Run = { binding, emit, controller: new AbortController(), prepared: new Map(), seen: new Set() };
      runs.set(binding.runId, run);

    },
    prepare,
    async dispatch(binding: ManagedPiRuntimeBinding, request: BotToolRequest, callerSignal: AbortSignal): Promise<BotToolResult> {
      let liveRun = await live(binding, callerSignal);
      if (!liveRun.run.prepared.has(request.toolCallId)) await prepare(binding, request, callerSignal);
      liveRun = await live(binding, callerSignal);
      const { run, permissionMode, signal } = liveRun;
      const prepared = run.prepared.get(request.toolCallId);
      run.prepared.delete(request.toolCallId);
      if (!prepared || prepared.args !== JSON.stringify(request.args)) throw new BotBrokerActionError("denied");
      if (request.capability === "integration.inventory") {
        const rows = await deps.integrations!.inventory(binding.ownerId, signal);
        return text(rows.filter(row => !request.args.service || row.service === request.args.service));
      }
      if (request.capability === "integration.describe") {
        return text({ service: request.args.service, actions: await described(binding, request.args.service, permissionMode, signal) });
      }
      if (request.capability === "integration.call") {
        const selected = await account(binding, request.args, signal);
        if (!prepared.account || selected.connectionId !== prepared.account.connectionId || selected.label !== prepared.account.label) throw new BotBrokerActionError("not_granted");
        const action = await actionFor(binding, request.args, permissionMode, signal);
        await live(binding, signal);
        return text(await deps.integrations!.call(binding.ownerId, { service: request.args.service, action: request.args.action,
          label: selected.label, params: request.args.params, read: action.risk === "read" }, signal));
      }
      if (request.capability === "mcp.inventory") return text(await deps.mcp!.inventory(binding.ownerId, signal));
      if (request.capability === "mcp.describe") return text(await deps.mcp!.describe(binding.ownerId, request.args.serverId, signal));
      if (request.capability === "mcp.call") {
        if (permissionMode !== "full_access" || !run.generation) throw new BotBrokerActionError("denied");
        return text(await deps.mcp!.call(binding.ownerId, { ...request.args, runId: binding.runId,
          ...(prepared.receipt ? { approvalReceipt: prepared.receipt } : {}) }, signal));
      }
      throw new BotBrokerActionError("not_granted");
    },
    async submit(input: Submit): Promise<void> {
      const run = runs.get(input.runId);
      if (!run || input.owner.type !== "personal" || input.owner.ownerId !== run.binding.ownerId || input.chatId !== run.binding.chatId
        || !["approve", "decline", "cancel"].includes(input.decision)) throw new BotBrokerActionError("denied");
      await live(run.binding, run.controller.signal);
      if (run.pending?.id === input.approvalId) { run.pending.resolve(input.decision); return; }
      if (!run.mcp) throw new BotBrokerActionError("denied");
      await run.mcp.submit(input.approvalId, input.decision, { chatId: input.chatId, clientRequestId: input.clientRequestId, platformApprovalProof: input.platformApprovalProof });
    },
    async closeRun(runId: string): Promise<void> {
      const run = runs.get(runId); if (!run) return;
      runs.delete(runId); run.controller.abort(); run.mcp?.close(); run.prepared.clear();
      if (run.mcpInitialization) {
        try { await run.mcpInitialization; }
        catch (error: unknown) { console.warn("[managed-pi] MCP initialization closed", error instanceof Error ? error.name : "UnknownError"); }
      }
      await revoke(run);
    },
  };
}
export type ManagedPiOwnerTools = ReturnType<typeof createManagedPiOwnerTools>;
