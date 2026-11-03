import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { nativeRecord, nativeRef, type NativeRecord } from "./claude-native-session-jobs.js";

const HooksSchema = z.object({ PreToolUse: z.array(z.object({ matcher: z.literal("Bash"), hookCallbackIds: z.array(nativeRef).length(1), timeout: z.number().int().min(1).max(120).optional() }).strict()).length(1) }).strict();
const McpReplacementSchema = z.object({
  added: z.array(nativeRef).max(16), removed: z.array(nativeRef).max(16),
  errors: z.record(nativeRef, z.string().max(8192)).refine(errors => Object.keys(errors).length <= 16),
}).passthrough();
export type NativeSessionControl = ReturnType<typeof createClaudeNativeSessionControl>;
export function createClaudeNativeSessionControl(options: {
  send(frame: unknown): Promise<void>; emit(frame: NativeRecord): void; timeoutMs: number;
}) {
  const promptCallbackId = `matrix_native_prompt_${randomBytes(24).toString("hex")}`;
  const cronCallbackId = `matrix_native_cron_${randomBytes(24).toString("hex")}`;
  let installedBashCallbackId = `matrix_native_bash_${randomBytes(24).toString("hex")}`;
  let phaseBashCallbackId: string | undefined, initialized = false, applied = false, version: string | undefined;
  let initializePromise: Promise<void> | undefined, initializationResponse: NativeRecord | undefined;
  const pending = new Map<string, { resolve(frame: NativeRecord): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(); // Max16; ACK/timeout/close removes.
  const request = (body: NativeRecord, requestId?: string) => new Promise<NativeRecord>((resolve, reject) => {
    if (pending.size >= 16) { reject(new Error("Native control request limit exceeded")); return; }
    const id = requestId ?? `matrix_native_control_${randomBytes(24).toString("hex")}`;
    if (pending.has(id)) { reject(new Error("Duplicate native control identity")); return; }
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native control timed out")); }, options.timeoutMs); timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    void options.send({ type: "control_request", request_id: id, request: body }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error("Native control unavailable"));
    });
  });
  const hooks = (bashId: string) => ({
    UserPromptSubmit: [{ hookCallbackIds: [promptCallbackId], timeout: 120 }],
    PreToolUse: [{ matcher: "Bash", hookCallbackIds: [bashId], timeout: 120 }, { matcher: "CronCreate|CronList|CronDelete", hookCallbackIds: [cronCallbackId], timeout: 10 }],
  });
  const ensure = async (requestId?: string) => {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const response = await request({ subtype: "initialize", hooks: hooks(installedBashCallbackId) }, requestId);
      const data = nativeRecord(response.response);
      if (response.subtype !== "success" || data?.hooks_applied !== true) throw new Error("Native hook registration unavailable");
      applied = true; initialized = true; initializationResponse = response;
      version = typeof data.claude_code_version === "string" ? data.claude_code_version : version;
    })();
    return initializePromise;
  };
  return {
    promptCallbackId, cronCallbackId,
    get bashCallbackId() { return installedBashCallbackId; },
    get phaseBashCallbackId() { return phaseBashCallbackId; },
    get qualified() { return applied && version === "2.1.317"; },
    beginPhase() { phaseBashCallbackId = undefined; },
    observeInit(frame: NativeRecord) { if (frame.type === "system" && frame.subtype === "init" && typeof frame.claude_code_version === "string") version = frame.claude_code_version; },
    handle(frame: NativeRecord): boolean {
      if (frame.type !== "control_response") return false;
      const response = nativeRecord(frame.response), id = response?.request_id;
      if (!response || typeof id !== "string") return false;
      const item = pending.get(id); if (!item) return false;
      pending.delete(id); clearTimeout(item.timer); item.resolve(response); return true;
    },
    async prepare(servers: NativeRecord, requestId?: string) {
      await ensure(requestId);
      const response = await request({ subtype: "mcp_set_servers", servers });
      const data = McpReplacementSchema.safeParse(response.response);
      if (response.subtype !== "success" || !data.success || Object.keys(data.data.errors).length > 0) throw new Error("Native MCP replacement unavailable");
    },
    /** A local phase binding, not a second native initialize. Reinitialize cancels a held native prompt in 2.1.317. */
    async registerPhase(frame: NativeRecord, servers: NativeRecord) {
      const req = nativeRecord(frame.request), parsed = HooksSchema.safeParse(req?.hooks), id = nativeRef.safeParse(frame.request_id);
      if (!parsed.success || !id.success || req?.subtype !== "initialize" || Object.keys(req).some(key => !["subtype", "hooks"].includes(key))) throw new Error("Native phase hook registration unavailable");
      phaseBashCallbackId = parsed.data.PreToolUse[0]!.hookCallbackIds[0]!;
      const first = !initialized && !initializePromise;
      if (first) installedBashCallbackId = phaseBashCallbackId;
      await this.prepare(servers, first ? id.data : undefined);
      options.emit({ type: "control_response", response: first ? initializationResponse!
        : { subtype: "success", request_id: id.data, response: { hooks_applied: applied } } });
    },
    remapBash(frame: NativeRecord): NativeRecord | undefined {
      const request = nativeRecord(frame.request);
      if (!request || request.callback_id !== installedBashCallbackId || !phaseBashCallbackId) return undefined;
      return { ...frame, request: { ...request, callback_id: phaseBashCallbackId } };
    },
    respond(id: string, response: NativeRecord) { return options.send({ type: "control_response", response: { subtype: "success", request_id: id, response } }); },
    close() { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Native control closed")); } pending.clear(); },
  };
}

/** Only current per-phase server configuration crosses the native control channel. */
export function nativePhaseMcpServers(args: string[], env: Record<string, string>): NativeRecord {
  const index = args.indexOf("--mcp-config");
  if (index < 0) return {};
  const parsed = nativeRecord(JSON.parse(args[index + 1] ?? "")), servers = nativeRecord(parsed?.mcpServers);
  if (!servers || Object.keys(servers).length > 16) throw new Error("Native MCP configuration unavailable");
  return Object.fromEntries(Object.entries(servers).map(([name, value]) => {
    const server = nativeRecord(value); if (!server) throw new Error("Native MCP configuration unavailable");
    return [name, name === "matrix-integrations" ? { ...server, env: { ...nativeRecord(server.env), MATRIX_AGENT_INTEGRATIONS_TOKEN: env.MATRIX_AGENT_INTEGRATIONS_TOKEN ?? "" } } : server];
  }));
}
