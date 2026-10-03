import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import {
  AiCreditHistoryQuerySchema, AiCreditHistoryResponseSchema, ProviderSettingsMutationSchema, ProviderSettingsSnapshotSchema,
  ProviderWorkflowCapabilitiesSchema, ProviderWorkflowKeySchema, ProviderWorkflowLogsSchema,
  ProviderWorkflowSchema, ProviderWorkflowStartSchema,
  type ProviderSettingsSnapshot, type ProviderWorkflow,
} from "@matrix-os/contracts";
import { providerAuthSettingsSnapshot, startProviderAuthGateway } from "./provider-auth-gateway";

const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 600_000).toISOString();
/** Contract-valid synthetic state. Never represents real provider authentication. */
function snapshot(authenticated: boolean, codexEnabled = true, revision = authenticated ? 3 : 2): ProviderSettingsSnapshot {
  const base = providerAuthSettingsSnapshot(true);
  const claude = base.harnesses[0]!;
  const account = base.accounts[0]!;
  const source = base.accessSources[0]!;
  return ProviderSettingsSnapshotSchema.parse({ ...base, refreshedAt: now(),
    revision,
    supportedActions: ["logout_account", "start_login", "add_credit", "set_harness_enabled"],
    modelProviders: [...base.modelProviders, { id: "openai", displayName: "OpenAI", models: [{ id: "openai/gpt-5.6", displayName: "GPT-5.6", enabled: true }] }],
    accounts: [account, { ...account, id: "codex_account", providerId: "openai", displayName: "Fixture API account", authMethod: "api_key", authState: authenticated ? "authenticated" : "unauthenticated", accessSourceId: "owner_openai_profile" }],
    accessSources: [source, { ...source, id: "owner_openai_profile", providerId: "openai", accountId: "codex_account", displayName: "Fixture API account", fundingKind: "owner_api_key", readiness: { ...source.readiness, state: authenticated ? "ready" : "auth_required", action: authenticated ? "none" : "open_terminal", safeReason: authenticated ? null : "auth" }, eligibleModelIds: ["openai/gpt-5.6"] },
      { id: "matrix_funded", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null, displayName: "Matrix AI", readiness: { state: "ready", checkedAt: now(), staleAfter: later(), action: "none", safeReason: null }, eligibleModelIds: ["anthropic/claude-opus-5"],
        usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD", usedMicrousd: 500_000, remainingMicrousd: 18_400_000, limitMicrousd: 20_000_000, periodStartedAt: now(), resetsAt: later(), asOf: now(), credit: { promotionalBalanceMicrousd: 0, addonBalanceMicrousd: 18_400_000, creditBalanceMicrousd: 18_400_000, reservedMicrousd: 0, remainingBalanceMicrousd: 18_400_000 }, budget: { monthlyBudgetMicrousd: 20_000_000, settledThisMonthMicrousd: 500_000, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 19_500_000 } } },
    ],
    harnesses: [
      { ...claude, displayName: "Claude Code" },
      { ...claude, id: "codex_harness", enabled: codexEnabled, configuredEnabled: codexEnabled, harness: "codex", displayName: "Codex", authState: authenticated ? "authenticated" : "unauthenticated", accountIds: ["codex_account"], selectedAccountId: "codex_account", accessSourceId: "owner_openai_profile", connectivity: authenticated ? "online" : "offline", route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } },
      { ...claude, id: "opencode_harness", harness: "opencode", displayName: "OpenCode", enabled: false, configuredEnabled: false },
      { ...claude, id: "pi_harness", harness: "pi", displayName: "Pi", authState: "expired" },
    ], gatewayPolicy: { accessSourceId: "matrix_funded", monthlyBudgetMicrousd: null, allowedModelIds: ["anthropic/claude-opus-5"], topUpEnabled: true },
  });
}

export async function startAgentsProvidersWorkflowGateway() {
  let authenticated = false;
  let codexEnabled = true;
  let revision = 2;
  const currentSnapshot = () => snapshot(authenticated, codexEnabled, revision);
  snapshot(false); snapshot(true);
  const upstream = await startProviderAuthGateway({ settings: currentSnapshot });
  const events: string[] = [];
  const operations = new Map<string, ProviderWorkflow>();
  let sequence = 0;
  const capabilities = ProviderWorkflowCapabilitiesSchema.parse([
    { harnessInstanceId: "claude_harness", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: true, logs: true },
    { harnessInstanceId: "codex_harness", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: true, logs: true },
    { harnessInstanceId: "hermes_inventory", harness: "hermes", displayName: "Hermes", installState: "missing", loginMethods: [], apiKeyProviders: [], install: true, uninstall: false, logs: true },
    { harnessInstanceId: "openclaw_inventory", harness: "openclaw", displayName: "OpenClaw", installState: "missing", loginMethods: [], apiKeyProviders: [], install: true, uninstall: false, logs: true },
  ]);
  function json(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw new Error("Fixture body exceeded limit"); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost"); const path = url.pathname;
      if (path === "/billing/ai-credit/history") {
        const query = AiCreditHistoryQuerySchema.parse(Object.fromEntries(url.searchParams));
        if (query.runtimeSlot !== "primary" || query.cursor && query.cursor !== "a".repeat(32)) return json(res, { error: "Invalid fixture history scope" }, 400);
        events.push("history"); const next = url.searchParams.has("cursor");
        return json(res, AiCreditHistoryResponseSchema.parse({ entries: [{ occurredAt: now(), kind: next ? "credit" : "usage", amountMicrousd: next ? 5_000_000 : -123_000, modelId: next ? null : "anthropic/claude-opus-5" }], nextCursor: next ? null : "a".repeat(32) }));
      }
      if (path === "/api/ai/provider-settings/workflows/capabilities") return json(res, ProviderWorkflowCapabilitiesSchema.parse(capabilities.map(capability => ({ ...capability,
        activeOperationId: [...operations.values()].findLast(operation => operation.harnessInstanceId === capability.harnessInstanceId && ["pending", "running"].includes(operation.state))?.id ?? null,
      }))));
      if (path.startsWith("/api/ai/provider-settings/workflows/logs/")) return json(res, ProviderWorkflowLogsSchema.parse({ entries: [{ at: now(), event: "started" }] }));
      if (path === "/api/ai/provider-settings/workflows/keys") {
        const key = ProviderWorkflowKeySchema.parse(await body(req));
        if (key.harnessInstanceId !== "codex_harness" || key.providerId !== "openai") return json(res, { error: "Unsupported fixture key target" }, 400);
        events.push("key-check");
        if (key.apiKey !== "sk-safe-fixture-valid") return json(res, { error: { code: "rejected", message: "The key could not be verified. Check it and try again." } }, 400);
        authenticated = true; codexEnabled = true; revision++; return json(res, { verified: true });
      }
      if (path === "/api/ai/provider-settings/workflows" && req.method === "POST") {
        const start = ProviderWorkflowStartSchema.parse(await body(req));
        const capability = capabilities.find(item => item.harnessInstanceId === start.harnessInstanceId);
        if (!capability || start.kind === "login" && (!start.method || !capability.loginMethods.includes(start.method)) || start.kind === "install" && !capability.install || start.kind === "uninstall" && !capability.uninstall) return json(res, { error: "Unsupported fixture operation" }, 400);
        if (operations.size >= 32) return json(res, { error: "Fixture operation limit" }, 429);
        events.push(start.kind); const id = `fixture_operation_${++sequence}`;
        let terminalSessionId: string | null = null;
        if (start.kind === "install") {
          const authorization = req.headers.authorization ?? "";
          const workspaces = await (await fetch(`${upstream.url}/api/terminal/workspaces`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) })).json() as { workspaces: Array<{id:string}> };
          const workspaceId = workspaces.workspaces[0]?.id;
          if (!workspaceId) throw new Error("Missing fixture workspace");
          const result = await (await fetch(`${upstream.url}/api/terminal/workspaces/${workspaceId}/tabs`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ name: "Install Hermes", cwd: "projects", command: ["sh", "-lc", "printf 'Fixture installation only\\n'"] }), signal: AbortSignal.timeout(10_000) })).json() as { tab: {id:string} };
          terminalSessionId = `${workspaceId}:${result.tab.id}`;
        }
        const operation = ProviderWorkflowSchema.parse({ id, harnessInstanceId: start.harnessInstanceId, kind: start.kind, state: "running", expiresAt: later(), terminalSessionId, deviceCode: start.kind === "login" ? "TEST-CODE" : null, authorizationUrl: start.kind === "login" ? "https://auth.openai.com/codex/device" : null, safeFailure: null });
        operations.set(id, operation); return json(res, operation);
      }
      if (path.startsWith("/api/ai/provider-settings/workflows/")) {
        const id = path.split("/")[5]!; const operation = operations.get(id);
        if (!operation) return json(res, { error: "Unknown operation" }, 404);
        if (path.endsWith("/cancel")) { await body(req); operation.state = "cancelled"; events.push("cancel"); }
        return json(res, ProviderWorkflowSchema.parse(operation));
      }
      if (path === "/api/ai/provider-settings/actions" && req.method === "POST") {
        const mutation = ProviderSettingsMutationSchema.parse(await body(req));
        if (mutation.type !== "set_harness_enabled" || mutation.harnessInstanceId !== "codex_harness") return json(res, { error: "Unsupported fixture action" }, 400);
        if (mutation.expectedRevision !== revision) return json(res, {error: "Stale fixture revision"}, 409);
        events.push("disconnect"); codexEnabled = mutation.enabled; revision++;
        return json(res, { kind: "snapshot", snapshot: currentSnapshot() });
      }
      const forward = request(`${upstream.url}${req.url}`, { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
      forward.setTimeout(10_000, () => forward.destroy());
      forward.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(forward);
    } catch (error) { console.warn("[workflow-fixture] request rejected:", error instanceof Error ? error.name : typeof error); if (!res.headersSent) json(res, { error: "Invalid fixture request" }, 400); else res.end(); }
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("upgrade", (req, socket, head) => {
    if (sockets.size >= 64) { socket.destroy(); return; }
    const target = connect(Number(new URL(upstream.url).port), "127.0.0.1", () => {
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key,value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) target.write(head); target.pipe(socket); socket.pipe(target);
    });
    sockets.add(target); target.on("close", () => sockets.delete(target));
    target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy()); socket.on("close", () => target.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as {port:number}).port}`, events,
    expireLogin() { const operation = [...operations.values()].findLast(item => item.kind === "login"); if (!operation) throw new Error("No fixture login"); operation.state = "expired"; operation.safeFailure = "expired"; },
    async close() { operations.clear(); for (const socket of sockets) socket.destroy(); sockets.clear(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await upstream.close(); },
  };
}
