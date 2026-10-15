/** Native plugin contract verified against OpenClaw v2026.7.1; no OpenClaw SDK dependency is bundled. */
import { randomBytes } from "node:crypto";
import { SharedBrowserActionSchema, SHARED_BROWSER_TOOL_DESCRIPTION } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { callSharedBrowser, sharedBrowserEndpoint } from "./shared-browser-client.js";
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const BindingId = z.string().regex(/^[a-f0-9]{32}$/);
const Bind = z.object({ runId: Id, sessionKey: z.string().min(1).max(512), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int(), bindingId: BindingId.optional() }).strict();
const Revoke = z.object({ runId: Id, bindingId: BindingId.optional(), nativeNotStarted: z.literal(true).optional() }).strict()
  .refine(value => value.nativeNotStarted !== true || value.bindingId !== undefined);
const TICKET = "__matrix_browser_ticket";
const ToolInput = z.object({ [TICKET]: z.string().regex(/^[a-f0-9]{32}$/) }).passthrough();
const BYPASS = new Set(["browser", "exec", "execute", "bash", "process"]);
export interface Context { sessionKey?: string; runId?: string; toolCallId?: string; toolName?: string }
export interface NativeTool { name: string; label: string; description: string; parameters: unknown; execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> }
export interface SharedBrowserPluginApi {
  registerGatewayMethod(name: string, handler: (value: { params: unknown; respond(ok: boolean, result?: unknown, error?: unknown): void }) => Promise<void>, options: { scope: "operator.admin" }): void;
  registerTool(factory: (context: Context) => NativeTool | null, options: { names: string[]; optional: boolean }): void;
  on(name: string, handler: (event: { toolName?: string; params?: unknown }, context: Context) => unknown): void;
}
interface RevokedGuard { sessionKey: string; bindingId?: string; nativeObserved: boolean }
interface Lease extends z.infer<typeof Bind> { controller: AbortController; browserStarted: boolean; authenticated: boolean; nativeObserved: boolean; cancelledBindGuard?: RevokedGuard }
interface Ticket { lease: Lease; toolCallId: string; expiresAt: number; input: string }
type BindingDenial = "closed" | "run_context_missing" | "lease_missing" | "unauthenticated"
  | "session_mismatch" | "call_context_missing" | "invalid_action" | "ticket_capacity";
export type SharedBrowserLifecycleDiagnostic = {
  event: "bind_result" | "before_tool_call" | "agent_end" | "revoke" | "gateway_stop";
  generation: string;
  leaseCount: number;
  revokedCount: number;
  ticketCount: number;
  exactRunLeaseFound?: boolean;
  sameSessionLeasePresent?: boolean;
  success?: boolean;
};
export function createOpenClawSharedBrowserAuthority(options: {
  gatewayPort: number; fetcher?: typeof fetch; now?: () => number;
  onDiagnostic?: (event: SharedBrowserLifecycleDiagnostic) => void;
}) {
  sharedBrowserEndpoint(options.gatewayPort);
  const now = options.now ?? Date.now;
  const generation = options.onDiagnostic ? randomBytes(8).toString("hex") : "";
  const leases = new Map<string, Lease>(); // <=64, terminal/revoke/shutdown/30m TTL.
  // Shares the 64-run cap with leases. Native termination (or gateway stop)
  // evicts these credential-free guards; an elapsed TTL does not prove exit.
  const revoked = new Map<string, RevokedGuard>();
  const tickets = new Map<string, Ticket>(); // <=128, one-use, 10s TTL and lease removal.
  const pendingActions = new Map<string, { callId: string; toolCallId: string; sessionKey: string; ticket: Ticket; controller: AbortController; settled: Promise<void> }>(); // Shares the 128 ticket cap.
  let closed = false;
  function diagnostic(event: SharedBrowserLifecycleDiagnostic["event"], extra: Partial<Omit<SharedBrowserLifecycleDiagnostic, "event" | "generation" | "leaseCount" | "revokedCount" | "ticketCount">> = {}) {
    if (!options.onDiagnostic) return;
    try {
      options.onDiagnostic({ event, generation, leaseCount: leases.size, revokedCount: revoked.size, ticketCount: tickets.size, ...extra });
    } catch (error: unknown) {
      console.warn("[shared-browser-openclaw] Lifecycle diagnostic callback failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  function release(runId: string) { const lease = leases.get(runId); if (!lease) return; leases.delete(runId); lease.controller.abort();
    for (const [id,ticket] of tickets) if (ticket.lease === lease) tickets.delete(id); }
  function revoke(runId: string, proof?: z.infer<typeof Revoke>) {
    const lease = leases.get(runId);
    if (!lease) {
      const guard = revoked.get(runId);
      if (proof?.nativeNotStarted === true && proof.bindingId && guard?.bindingId === proof.bindingId && !guard.nativeObserved) revoked.delete(runId);
      return;
    }
    if (proof?.bindingId !== undefined && lease.bindingId !== proof.bindingId) return;
    // Only the trusted operator RPC can prove it never dispatched inference.
    // An exact binding nonce prevents old cleanup from reclaiming a new run.
    if (proof?.nativeNotStarted === true && proof.bindingId && !lease.nativeObserved) { release(runId); return; }
    // Abort is asynchronous in the native harness. Remove bearer authority
    // immediately without reopening native browser/shell fallbacks meanwhile.
    const guard = { sessionKey: lease.sessionKey, bindingId: lease.bindingId, nativeObserved: lease.nativeObserved };
    revoked.set(runId, guard);
    // An unauthenticated reservation has not acknowledged a native start.
    // Keep its exact guard until that bind's asynchronous work settles.
    if (!lease.authenticated) lease.cancelledBindGuard = guard;
    release(runId);
  }
  function sweep() { for (const lease of leases.values()) if (lease.expiresAt <= now()) revoke(lease.runId);
    for (const [id,ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id); }
  let timer: ReturnType<typeof setInterval> | undefined;
  function startSweep() { timer ??= setInterval(sweep, 10_000); timer.unref(); }
  const unavailable = { block: true, blockReason: "Use the Matrix shared browser tool for this task. Native browser and shell control are unavailable for this run." };
  const bindingUnavailable = { block: true, blockReason: "The Matrix browser binding is unavailable for this run. Ask the owner to retry this task. Native browser and shell control remain unavailable." };
  function refuseBinding(reason: BindingDenial) {
    // Fixed categories distinguish native binding failures without logging owner or tool data.
    console.warn("[shared-browser-openclaw] Tool binding refused", reason);
    return bindingUnavailable;
  }
  const bind: Parameters<SharedBrowserPluginApi["registerGatewayMethod"]>[1] = async ({ params, respond }) => {
    let pending: Lease | undefined;
    try {
      sweep(); const parsed = Bind.parse(params);
      if (closed || parsed.expiresAt <= now() || parsed.expiresAt > now() + 30 * 60_000 || leases.size + revoked.size >= 64 || leases.has(parsed.runId) || revoked.has(parsed.runId)
        || [...leases.values(), ...revoked.values()].some(lease => lease.sessionKey === parsed.sessionKey)) throw new Error("Browser binding unavailable");
      // Reserve before the network await: capacity and revoke also cover in-flight authentication.
      pending = { ...parsed, controller: new AbortController(), browserStarted: false, authenticated: false, nativeObserved: false };
      leases.set(parsed.runId, pending); startSweep();
      await callSharedBrowser({ ...options, token: parsed.token, action: { action: "status" }, signal: pending.controller.signal });
      if (closed || parsed.expiresAt <= now() || pending.controller.signal.aborted || leases.get(parsed.runId) !== pending) throw new Error("Browser binding unavailable");
      pending.authenticated = true; respond(true, { bound: true });
      diagnostic("bind_result", { success: true, exactRunLeaseFound: leases.get(parsed.runId) === pending });
    } catch (error: unknown) {
      // A failed bind cannot start native inference, so it needs no tombstone.
      if (pending && leases.get(pending.runId) === pending) release(pending.runId);
      if (pending && !pending.authenticated && pending.cancelledBindGuard
        && revoked.get(pending.runId) === pending.cancelledBindGuard) revoked.delete(pending.runId);
      console.warn("[shared-browser-openclaw] Binding refused", error instanceof Error ? error.name : "UnknownError");
      respond(false, undefined, { code: "INVALID_REQUEST", message: "Browser binding unavailable." });
      diagnostic("bind_result", { success: false, exactRunLeaseFound: pending !== undefined && leases.get(pending.runId) === pending }); }
  };
  const revokeRequest: Parameters<SharedBrowserPluginApi["registerGatewayMethod"]>[1] = async ({ params, respond }) => {
    const parsed = Revoke.safeParse(params);
    if (!parsed.success) { respond(false, undefined, { code: "INVALID_REQUEST", message: "Browser binding unavailable." }); return; }
    const exactRunLeaseFound = leases.has(parsed.data.runId);
    revoke(parsed.data.runId, parsed.data); respond(true, { revoked: true });
    diagnostic("revoke", { exactRunLeaseFound });
  };
  const beforeToolCall = (event: { toolName?: string; params?: unknown }, context: Context) => {
    sweep(); const lease = context.runId ? leases.get(context.runId) : undefined;
    diagnostic("before_tool_call", {
      exactRunLeaseFound: lease !== undefined,
      sameSessionLeasePresent: context.sessionKey !== undefined && [...leases.values()].some(candidate => candidate.sessionKey === context.sessionKey),
    });
    if (lease && lease.sessionKey === context.sessionKey) lease.nativeObserved = true;
    const guard = context.runId ? revoked.get(context.runId) : undefined;
    if (guard && guard.sessionKey === context.sessionKey) guard.nativeObserved = true;
    const name = event.toolName ?? context.toolName;
    if (name !== "shared_browser") return (context.runId && revoked.has(context.runId) && BYPASS.has(name ?? ""))
      || (lease && (name === "browser" || lease.browserStarted && BYPASS.has(name ?? ""))) ? unavailable : undefined;
    const input = SharedBrowserActionSchema.safeParse(event.params);
    if (closed) return refuseBinding("closed");
    if (!context.runId) return refuseBinding("run_context_missing");
    if (!lease) return refuseBinding("lease_missing");
    if (!lease.authenticated) return refuseBinding("unauthenticated");
    if (lease.sessionKey !== context.sessionKey) return refuseBinding("session_mismatch");
    if (!context.toolCallId) return refuseBinding("call_context_missing");
    if (!input.success) return refuseBinding("invalid_action");
    if (tickets.size + pendingActions.size >= 128) return refuseBinding("ticket_capacity");
    if (input.data.action !== "status") lease.browserStarted = true;
    const id = randomBytes(16).toString("hex");
    tickets.set(id, { lease, toolCallId: context.toolCallId, expiresAt: Math.min(now() + 10_000, lease.expiresAt), input: JSON.stringify(input.data) });
    return { params: { ...input.data, [TICKET]: id } };
  };
  const createTool = (context: Context): NativeTool | null => {
    if (!context.sessionKey) return null;
    return { name: "shared_browser", label: "Chrome", parameters: z.toJSONSchema(SharedBrowserActionSchema),
      description: SHARED_BROWSER_TOOL_DESCRIPTION,
      async execute(toolCallId, raw, signal) {
        sweep(); const parsed = ToolInput.parse(raw); const id = parsed[TICKET]; const ticket = tickets.get(id); tickets.delete(id);
        const { [TICKET]: _ticket, ...rest } = parsed; const action = SharedBrowserActionSchema.parse(rest);
        if (closed || !ticket || ticket.toolCallId !== toolCallId || ticket.lease.sessionKey !== context.sessionKey
          || ticket.input !== JSON.stringify(action) || leases.get(ticket.lease.runId) !== ticket.lease || ticket.lease.controller.signal.aborted) throw new Error("Browser action unavailable");
        const result = await callSharedBrowser({ ...options, token: ticket.lease.token, action,
          signal: AbortSignal.any([...(signal ? [signal] : []), ticket.lease.controller.signal]) });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
      } };
  };
  const agentEnd = (_event: unknown, context: Context) => {
    const exactRunLeaseFound = context.runId !== undefined && leases.has(context.runId);
    if (context.runId) { release(context.runId); revoked.delete(context.runId); }
    diagnostic("agent_end", { exactRunLeaseFound });
  };
  async function executeAction(context: Context, toolCallId: string, raw: unknown, callId: string, signal?: AbortSignal) {
    const id = ToolInput.parse(raw)[TICKET]; const ticket = tickets.get(id);
    if (!ticket || !context.sessionKey || pendingActions.has(id) || pendingActions.size >= 128 || callId !== id) throw new Error("Browser action unavailable");
    const controller = new AbortController(); const settled = Promise.withResolvers<void>();
    const pending = { callId, toolCallId, sessionKey: context.sessionKey, ticket, controller, settled: settled.promise };
    pendingActions.set(id, pending);
    try { return await createTool(context)!.execute(toolCallId, raw, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])); }
    finally { if (pendingActions.get(id) === pending) pendingActions.delete(id); settled.resolve(); }
  }
  async function cancelAction(value: { ticketId: string; callId: string; toolCallId: string; sessionKey: string }) {
    if (value.callId !== value.ticketId) throw new Error("Browser action unavailable");
    const pending = pendingActions.get(value.ticketId); const ticket = pending?.ticket ?? tickets.get(value.ticketId);
    if (!ticket) return { cancelled: false, settled: true };
    if (pending && pending.callId !== value.callId || ticket.toolCallId !== value.toolCallId || ticket.lease.sessionKey !== value.sessionKey) throw new Error("Browser action unavailable");
    tickets.delete(value.ticketId);
    if (leases.get(ticket.lease.runId) === ticket.lease) revoke(ticket.lease.runId, { runId: ticket.lease.runId, bindingId: ticket.lease.bindingId });
    pending?.controller.abort();
    if (pending) await pending.settled;
    return { cancelled: true, settled: true };
  }
  async function drain() {
    close(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...pendingActions.values()].map(p => p.settled)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Browser cleanup unavailable")), 10_000); })]); }
    finally { clearTimeout(timer); }
  }
  function endRun(context: { runId: string; sessionKey: string }) {
    const lease = leases.get(context.runId) ?? revoked.get(context.runId);
    if (lease && lease.sessionKey !== context.sessionKey) throw new Error("Browser action unavailable");
    agentEnd({}, context);
  }
  function close() { if (closed) return; closed = true; clearInterval(timer); for (const runId of leases.keys()) release(runId); revoked.clear(); tickets.clear(); diagnostic("gateway_stop"); }
  return { bind, revokeRequest, beforeToolCall, createTool, executeAction, cancelAction, endRun, agentEnd, close, drain };
}

export function registerOpenClawSharedBrowserPlugin(api: SharedBrowserPluginApi, options: Parameters<typeof createOpenClawSharedBrowserAuthority>[0]): () => void {
  const owner = createOpenClawSharedBrowserAuthority(options);
  api.registerGatewayMethod("matrix.browser.bind", owner.bind, { scope: "operator.admin" });
  api.registerGatewayMethod("matrix.browser.revoke", owner.revokeRequest, { scope: "operator.admin" });
  api.on("before_tool_call", owner.beforeToolCall);
  api.registerTool(owner.createTool, { names: ["shared_browser"], optional: false });
  api.on("agent_end", owner.agentEnd);
  api.on("gateway_stop", owner.close);
  return owner.close;
}
