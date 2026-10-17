/** A process-only overlay preserves the owner's native model/login/configuration. No persistent config writes. */
import { SHARED_BROWSER_ACTION_DEADLINE_MS, type CanonicalOwnerScope } from "@matrix-os/contracts";
import type { SharedBrowserBroker } from "../shared-browser/broker.js";
import type { HermesGatewayEvent } from "./hermes-stdio-client.js";
import { sharedBrowserEndpoint } from "./shared-browser-client.js";
import { z } from "zod/v4";
const TOOL = "mcp__matrix_shared_browser__shared_browser";
const Catalog = z.object({ lazy: z.boolean().optional(), tools: z.record(z.string().max(128), z.array(z.string().max(256)).max(512)) });
export function openHermesSharedBrowserRun(options: { broker: SharedBrowserBroker; root: string; gatewayPort: number; owner: CanonicalOwnerScope;
  chatId: string; runId: string; signal: AbortSignal }) {
  if (options.owner.type !== "personal") throw new Error("Browser run unavailable");
  sharedBrowserEndpoint(options.gatewayPort);
  const lease = options.broker.openRun({ ownerId: options.owner.ownerId, chatId: options.chatId, runId: options.runId, harness: "hermes" }, options.signal);
  const env = { MATRIX_SHARED_BROWSER_TOKEN: lease.token, MATRIX_SHARED_BROWSER_GATEWAY_PORT: String(options.gatewayPort) };
  // load_config and load_config_readonly are the actual exported startup seams in pinned d337b736.
  // The MCP runtime filters inherited env, so the bearer is supplied ONLY to the dedicated server config.
  const code = ["import sys, os, runpy, copy", `sys.path.insert(0, ${JSON.stringify(options.root)})`,
    "from hermes_cli import config as matrix_config", "matrix_load = matrix_config.load_config", "matrix_readonly = matrix_config.load_config_readonly",
    "def matrix_browser_overlay(value):", "    value = copy.deepcopy(value)", "    servers = value.get('mcp_servers', {})",
    "    if not isinstance(servers, dict): raise RuntimeError('Browser configuration unavailable')",
    "    value['mcp_servers'] = dict(servers)",
    `    value['mcp_servers']['matrix_shared_browser'] = {'command':'/opt/matrix/runtime/node/bin/node', 'args':['/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js'], 'enabled':True, 'timeout':${(SHARED_BROWSER_ACTION_DEADLINE_MS + 30_000) / 1000}, 'connect_timeout':20, 'supports_parallel_tool_calls':False, 'env': {'MATRIX_SHARED_BROWSER_TOKEN':os.environ['MATRIX_SHARED_BROWSER_TOKEN'], 'MATRIX_SHARED_BROWSER_GATEWAY_PORT':os.environ['MATRIX_SHARED_BROWSER_GATEWAY_PORT']}, 'tools':{'include':['shared_browser'], 'resources':False, 'prompts':False}}`,
    "    agent = value.get('agent', {})", "    if not isinstance(agent, dict): raise RuntimeError('Browser configuration unavailable')",
    "    disabled = agent.get('disabled_toolsets', [])", "    if not isinstance(disabled, list) or not all(isinstance(item,str) for item in disabled): raise RuntimeError('Browser configuration unavailable')",
    "    value['agent'] = dict(agent)", "    value['agent']['disabled_toolsets'] = list(dict.fromkeys(disabled + ['browser']))", "    return value",
    "matrix_config.load_config = lambda: matrix_browser_overlay(matrix_load())",
    "matrix_config.load_config_readonly = lambda: matrix_browser_overlay(matrix_readonly())",
    "runpy.run_module('tui_gateway.entry', run_name='__main__')"].join("\n");
  let sessionId: string | undefined, observed: HermesGatewayEvent | undefined, valid = false, failed = false;
  let changed: (() => void) | undefined, closing: Promise<void> | undefined;
  function inspect() {
    if (!sessionId || observed?.session_id !== sessionId) return;
    const catalog = Catalog.safeParse(observed.payload);
    if (!catalog.success || catalog.data.lazy) return;
    const groups = Object.values(catalog.data.tools);
    const names = groups.flat();
    valid = groups.length <= 32 && names.length <= 1024 && names.includes(TOOL) && !names.some(name => name.startsWith("browser_"));
    failed = !valid; changed?.();
  }
  return { env, args: ["-u", "-c", code],
    observe(event: HermesGatewayEvent) { if (event.type !== "session.info" || (sessionId && event.session_id !== sessionId)) return; observed = event; inspect(); },
    setSession(id: string) { sessionId = id; inspect(); },
    async ready(signal: AbortSignal) {
      signal.throwIfAborted(); if (failed) throw new Error("Native browser tool unavailable"); if (valid) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); changed = undefined; };
        const abort = () => { cleanup(); reject(new Error("Native browser tool unavailable")); };
        const timer = setTimeout(abort, 20_000); timer.unref();
        changed = () => { cleanup(); if (valid && !failed) resolve(); else reject(new Error("Native browser tool unavailable")); };
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    },
    close(): Promise<void> { return closing ??= options.broker.closeRun(options.runId); },
  };
}
