import { SharedBrowserActionSchema, SHARED_BROWSER_TOOL_DESCRIPTION } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { OpenClawRpcClient } from "../agent-config/openclaw-rpc.js";
import { createOpenClawSharedBrowserAuthority, type SharedBrowserPluginApi, type Context } from "./openclaw-shared-browser-plugin.js";
import {
  BROWSER_AUTHORITY_METHODS, BROWSER_AUTHORITY_TIMEOUT_MS, BrowserBeforeResultSchema, BrowserCancelResultSchema,
  BrowserToolInputSchema, BrowserToolResultSchema, BROWSER_TICKET, BrowserContextSchema,
} from "./openclaw-shared-browser-rpc.js";

type Service = { id: string; start(): void; stop(): Promise<void> };
export interface SharedBrowserRelayApi extends SharedBrowserPluginApi {
  registerService(service: Service): void;
  lifecycle: { registerRuntimeLifecycle(value: { id: string; cleanup(): Promise<void> }): void };
}
const blocked = { block: true, blockReason: "Matrix browser binding is unavailable. Stop this browser action and report the failure; do not retry." };
const nativeBypass = new Set(["browser", "exec", "execute", "bash", "process"]);

/** The authenticated gateway handler owns grants; registry-local hooks only relay fixed requests. */
export function registerOpenClawSharedBrowserRelay(api: SharedBrowserRelayApi, options: {
  gatewayPort: number; rpc: OpenClawRpcClient;
  fetcher?: typeof fetch; now?: () => number;
  onDiagnostic?: Parameters<typeof createOpenClawSharedBrowserAuthority>[0]["onDiagnostic"];
}): () => Promise<void> {
  if (typeof api.registerService !== "function" || typeof api.lifecycle?.registerRuntimeLifecycle !== "function") throw new Error("Native browser lifecycle unavailable");
  const owner = createOpenClawSharedBrowserAuthority(options);
  const lifetime = new AbortController();
  const actions = new Set<Promise<unknown>>(); // <=8; completion or retirement drains.
  class CleanupUnconfirmed extends Error {}
  let cleanupUnconfirmed = false;
  let closing = false; let relayClose: Promise<void> | undefined; let close: Promise<void> | undefined;
  api.registerGatewayMethod("matrix.browser.bind", owner.bind, { scope: "operator.admin" });
  api.registerGatewayMethod("matrix.browser.revoke", owner.revokeRequest, { scope: "operator.admin" });
  for (const [method, schema] of Object.entries(BROWSER_AUTHORITY_METHODS)) {
    api.registerGatewayMethod(method, async ({ params, respond }) => {
      try {
        const value = schema.parse(params); let result: unknown;
        if (method === "matrix.browser.before") {
          const input = BROWSER_AUTHORITY_METHODS["matrix.browser.before"].parse(value);
          const before = owner.beforeToolCall(input.event, input.context);
          if (before && "params" in before) {
            const parsed = BrowserToolInputSchema.parse(before.params);
            const { [BROWSER_TICKET]: ticketId, ...rest } = parsed;
            result = { kind: "ticket", ticketId, action: SharedBrowserActionSchema.parse(rest) };
          } else result = { kind: before?.block ? "block" : "allow" };
        } else if (method === "matrix.browser.execute") {
          const input = BROWSER_AUTHORITY_METHODS["matrix.browser.execute"].parse(value);
          const response = await owner.executeAction({ sessionKey: input.sessionKey }, input.toolCallId,
            { ...input.action, [BROWSER_TICKET]: input.ticketId }, input.callId);
          result = { content: response.content };
        } else if (method === "matrix.browser.cancel") {
          result = await owner.cancelAction(BROWSER_AUTHORITY_METHODS["matrix.browser.cancel"].parse(value));
        } else {
          owner.endRun(BROWSER_AUTHORITY_METHODS["matrix.browser.end"].parse(value)); result = { ended: true };
        }
        respond(true, result);
      } catch (error: unknown) {
        console.warn("[shared-browser-openclaw] Authority request refused", error instanceof Error ? error.name : "UnknownError");
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Browser action unavailable." });
      }
    }, { scope: "operator.admin" });
  }
  const request = (method: string, params: unknown, signal: AbortSignal, timeoutMs = 10_000) => options.rpc.call(method, params, signal, { timeoutMs });
  api.on("before_tool_call", async (event, context) => {
    const toolName = event.toolName ?? context.toolName;
    try {
      if (closing) return blocked;
      const normalized = BrowserContextSchema.parse({ runId: context.runId, sessionKey: context.sessionKey, toolCallId: context.toolCallId, toolName: context.toolName });
      const action = toolName === "shared_browser" ? { toolName, params: SharedBrowserActionSchema.parse(event.params) }
        : { toolName: nativeBypass.has(toolName ?? "") ? toolName : "other" };
      const result = BrowserBeforeResultSchema.parse(await request("matrix.browser.before", { event: action, context: normalized }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])));
      if (result.kind === "allow") return undefined;
      if (result.kind === "block") return blocked;
      return { params: { ...result.action, [BROWSER_TICKET]: result.ticketId } };
    } catch (error: unknown) {
      console.warn("[shared-browser-openclaw] Browser authority unavailable", error instanceof Error ? error.name : "UnknownError");
      return blocked;
    }
  });
  api.registerTool(context => {
    if (!context.sessionKey) return null;
    return { name: "shared_browser", label: "Chrome", description: SHARED_BROWSER_TOOL_DESCRIPTION,
      parameters: z.toJSONSchema(SharedBrowserActionSchema),
      execute(toolCallId, raw, signal) {
        if (closing || actions.size >= 8) return Promise.reject(new Error("Browser action unavailable"));
        const execute = async () => {
          const parsed = BrowserToolInputSchema.parse(raw);
          const { [BROWSER_TICKET]: ticketId, ...rest } = parsed;
          const action = SharedBrowserActionSchema.parse(rest); const callId = ticketId;
          const params = { sessionKey: context.sessionKey!, toolCallId, ticketId, callId, action };
          const requestSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(BROWSER_AUTHORITY_TIMEOUT_MS), ...(signal ? [signal] : [])]);
          try {
            requestSignal.throwIfAborted();
            const result = BrowserToolResultSchema.parse(await request("matrix.browser.execute", params, requestSignal, BROWSER_AUTHORITY_TIMEOUT_MS));
            return { ...result, details: undefined };
          } catch (error: unknown) {
            const { action: _action, ...cancel } = params;
            try {
              BrowserCancelResultSchema.parse(await request("matrix.browser.cancel", cancel, AbortSignal.timeout(10_000)));
            } catch (cancelError: unknown) {
              cleanupUnconfirmed = true;
              console.warn("[shared-browser-openclaw] Action cleanup unconfirmed", cancelError instanceof Error ? cancelError.name : "UnknownError");
              throw new CleanupUnconfirmed("Browser cleanup unavailable");
            }
            throw error;
          }
        };
        const task = execute(); actions.add(task);
        void task.then(() => actions.delete(task), () => actions.delete(task));
        return task;
      },
    };
  }, { names: ["shared_browser"], optional: false });
  api.on("agent_end", async (_event, context) => {
    if (!context.runId || !context.sessionKey || closing) return;
    await request("matrix.browser.end", { runId: context.runId, sessionKey: context.sessionKey }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
  });
  function closeRelay(): Promise<void> {
    return relayClose ??= (async () => {
      closing = true; lifetime.abort();
      const settled = await Promise.allSettled([...actions]);
      await options.rpc.close();
      if (cleanupUnconfirmed || settled.some(result => result.status === "rejected" && result.reason instanceof CleanupUnconfirmed)) throw new Error("Browser cleanup unavailable");
    })();
  }
  function closeAll(): Promise<void> { return close ??= Promise.all([owner.drain(), closeRelay()]).then(() => {}); }
  // Startup service stop is captured by the native service manager, independent of later hook composition.
  api.registerService({ id: "matrix-shared-browser-authority", start() {}, stop: closeAll });
  api.lifecycle.registerRuntimeLifecycle({ id: "matrix-shared-browser-relay", cleanup: closeRelay });
  api.on("gateway_stop", closeRelay);
  return closeAll;
}
