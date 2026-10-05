import { createServer, request } from "node:http";
import { connect } from "node:net";
import { startStubGateway } from "./stub-gateway";
import { createNativeProviderWorkflowAdapters } from "../../../../packages/gateway/src/ai-providers/provider-workflow-native";
import type { ProviderSettingsStoreWriter } from "../../../../packages/gateway/src/ai-providers/provider-settings-store";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { providerAuthActions } from "../../../../packages/gateway/src/coding-agents/provider-auth-actions";
import {
  ProviderSettingsMutationSchema,
  ProviderWorkflowCapabilitiesSchema, ProviderWorkflowCodeSchema, ProviderWorkflowStartSchema, ProviderWorkflowSchema,
  type ProviderWorkflow,
  ProviderSettingsSnapshotSchema,
  type AgentProviderSummary,
  type CanonicalProviderCatalog,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";

const NOW = "2026-09-20T00:00:00.000Z";

export function providerAuthSettingsSnapshot(authenticated: boolean): ProviderSettingsSnapshot {
  const authState = authenticated ? "authenticated" as const : "unauthenticated" as const;
  return ProviderSettingsSnapshotSchema.parse({
    contractVersion: 1,
    atomicConnectSupported: false,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: authenticated ? 2 : 1 },
    revision: authenticated ? 2 : 1,
    refreshedAt: NOW,
    access: { mode: "writable" },
    supportedActions: [authenticated ? "logout_account" : "start_login", "set_harness_enabled"],
    harnessCatalog: (["hermes", "openclaw", "pi", "opencode"] as const).map((harness) => ({
      harness,
      displayName: harness === "openclaw" ? "OpenClaw" : harness[0]!.toUpperCase() + harness.slice(1),
      installState: "unknown",
      available: false,
      runnable: false,
      setupAction: "none",
      safeReason: "runtime_not_supported",
    })),
    modelProviders: [{
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true }],
    }],
    accessSources: [{
      id: "claude_account_source",
      kind: "provider_account",
      fundingKind: "owner_subscription",
      providerId: "anthropic",
      accountId: "claude_account",
      displayName: "Claude account",
      readiness: authenticated
        ? { state: "ready", checkedAt: NOW, staleAfter: null, action: "none", safeReason: null }
        : { state: "auth_required", checkedAt: NOW, staleAfter: null, action: "open_terminal", safeReason: "auth" },
      eligibleModelIds: ["anthropic/claude-opus-5"],
      usage: authenticated
        ? { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "account", reason: "provider_does_not_report", asOf: NOW }
        : { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "account", reason: "not_authenticated", asOf: NOW },
    }],
    accounts: [{
      id: "claude_account",
      providerId: "anthropic",
      displayName: "Claude",
      authMethod: "terminal",
      authState,
      lastCheckedAt: NOW,
      accessSourceId: "claude_account_source",
      dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 },
    }],
    harnesses: [{
      id: "claude_harness",
      harness: "claude",
      displayName: "Claude",
      accentColor: "orange",
      enabled: true,
      version: "fixture",
      installState: "installed",
      authState,
      loginMethods: ["terminal"],
      recommendedLoginMethod: "terminal",
      connectivity: authenticated ? "online" : "offline",
      accountIds: ["claude_account"],
      selectedAccountId: "claude_account",
      accessSourceId: "claude_account_source",
      route: { kind: "fixed", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      activeChatCount: 0,
    }],
    gatewayPolicy: null,
  });
}

/** Isolated provider fixture; no real provider login/logout is executed. */
export async function startProviderAuthGateway(options: {
  inlineClaude?: boolean;
  catalog?: CanonicalProviderCatalog;
  settings?: (authenticated: boolean) => ProviderSettingsSnapshot;
  failSettingsRead?: () => boolean;
} = {}) {
  const upstream = await startStubGateway();
  let authenticated = false;
  const commands: unknown[] = [];
  const enabledOverrides: Record<string, boolean> = options.inlineClaude ? { claude_harness: false } : {};
  let committedRevision: number | undefined;
  // Fixture lifetime cache: at most 32 mutation receipts, evicted oldest first.
  const disableReceipts = new Map<string, string>();
  const workflowEvents: string[] = [];
  let operation: ProviderWorkflow | null = null;
  // Fixture lifetime cache: settled starts may be evicted; a live receipt is retained.
  const startReceipts = new Map<string, { fingerprint: string; operation: ProviderWorkflow }>();
  let workflowSequence = 0;
  let completeNativeLogin: ((code: string) => Promise<void>) | null = null;
  const settings = () => {
    const snapshot = options.settings?.(authenticated) ?? providerAuthSettingsSnapshot(authenticated);
    return ProviderSettingsSnapshotSchema.parse({ ...snapshot, revision: committedRevision ?? snapshot.revision,
      projectionOf: { ...snapshot.projectionOf, revision: committedRevision ?? snapshot.projectionOf.revision }, harnesses: snapshot.harnesses.map(harness => harness.id in enabledOverrides
      ? { ...harness, enabled: enabledOverrides[harness.id]!, configuredEnabled: enabledOverrides[harness.id]! }
      : harness) });
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (options.inlineClaude && path.startsWith("/api/ai/provider-settings/workflows")) {
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      try {
        const active = operation && ["pending", "running"].includes(operation.state);
        if (req.method === "GET" && path.endsWith("/capabilities")) return json(ProviderWorkflowCapabilitiesSchema.parse([{
          harnessInstanceId: "claude_harness", harness: "claude", displayName: "Claude", installState: "installed",
          loginMethods: new URL(req.url!, "http://localhost").searchParams.get("connectionVersion") === "2" ? ["browser"] : ["terminal"],
          apiKeyProviders: [], install: false, uninstall: false, logs: false,
          activeOperationId: active ? operation!.id : null,
        }]));
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8192) throw new Error("Fixture body exceeded limit");
          chunks.push(Buffer.from(chunk));
        }
        const body = req.method === "POST" ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        if (req.method === "POST" && path === "/api/ai/provider-settings/workflows") {
          const start = ProviderWorkflowStartSchema.parse(body);
          const fingerprint = JSON.stringify(start);
          const receipt = startReceipts.get(start.idempotencyKey);
          if (receipt) return receipt.fingerprint === fingerprint ? json(receipt.operation)
            : json({ error: "Conflicting fixture workflow retry" }, 409);
          if (start.harnessInstanceId !== "claude_harness" || start.kind !== "login" || start.method !== "browser" || active)
            return json({ error: "Unsupported fixture workflow" }, 400);
          if (startReceipts.size >= 32) {
            const settled = [...startReceipts].find(([, value]) => !["pending", "running"].includes(value.operation.state));
            if (!settled) return json({ error: "Fixture workflow limit reached" }, 429);
            startReceipts.delete(settled[0]);
          }
          workflowEvents.push("browser-login");
          operation = ProviderWorkflowSchema.parse({ id: `fixture_claude_${++workflowSequence}`, harnessInstanceId: start.harnessInstanceId,
            kind: "login", state: "running", expiresAt: new Date(Date.now() + 600_000).toISOString(),
            terminalSessionId: null, deviceCode: null, authorizationUrl: "https://claude.com/cai/oauth/authorize", safeFailure: null });
          const terminalUnavailable = async () => { throw new Error("Inline fixture must not open Terminal"); };
          const [adapter] = await createNativeProviderWorkflowAdapters({
            store: {
              getSnapshot: async () => settings(),
              mutate: async (mutation: unknown) => {
                const action = ProviderSettingsMutationSchema.parse(mutation);
                if (action.type !== "set_harness_enabled" || action.harnessInstanceId !== "claude_harness"
                  || !action.enabled || action.expectedRevision !== settings().revision)
                  throw new Error("Invalid native fixture enablement");
                enabledOverrides.claude_harness = true;
                committedRevision = settings().revision + 1;
                workflowEvents.push("agent-enabled");
                return { kind: "snapshot", snapshot: settings() };
              },
            } as unknown as ProviderSettingsStoreWriter,
            terminal: { ensureWorkspace: terminalUnavailable, createTab: terminalUnavailable,
              terminateTab: terminalUnavailable, attach: () => { throw new Error("Inline fixture must not attach Terminal"); },
              listWorkspaces: terminalUnavailable } as Pick<TerminalRuntimeSocketClient, "ensureWorkspace" | "createTab" | "terminateTab" | "attach" | "listWorkspaces">,
            hostControl: { available: false, run: terminalUnavailable },
            claudeBrowserLogin: async ({ onSuccess }) => ({ cancel: async () => {}, submitCode: async (code) => {
              if (code !== "synthetic-fixture-code") throw new Error("Rejected fixture code");
              await onSuccess();
            } }),
          });
          const nativeLogin = await adapter!.start({ request: start, publish: () => {}, registerCleanup: () => {} });
          completeNativeLogin = nativeLogin.submitCode ?? null;
          startReceipts.set(start.idempotencyKey, { fingerprint, operation });
          return json(operation);
        }
        const operationPath = operation ? `/api/ai/provider-settings/workflows/${operation.id}` : null;
        if (operation && req.method === "GET" && path === operationPath) return json(ProviderWorkflowSchema.parse(operation));
        if (operation && active && req.method === "POST" && path === `${operationPath}/cancel`) {
          completeNativeLogin = null;
          Object.assign(operation, { state: "cancelled", authorizationUrl: null });
          workflowEvents.push("cancel"); return json(ProviderWorkflowSchema.parse(operation));
        }
        if (operation && active && req.method === "POST" && path === `${operationPath}/code`) {
          const { code } = ProviderWorkflowCodeSchema.parse(body);
          if (code !== "synthetic-fixture-code") return json({ error: "Rejected fixture code" }, 400);
          committedRevision = settings().revision + 1;
          authenticated = true;
          workflowEvents.push("code-completed");
          if (!completeNativeLogin) throw new Error("Native login completion unavailable");
          await completeNativeLogin(code);
          completeNativeLogin = null;
          Object.assign(operation, { state: "succeeded", authorizationUrl: null });
          return json({ accepted: true });
        }
        return json({ error: "Unknown fixture workflow" }, 404);
      } catch (error) {
        console.warn("[provider-auth-fixture] Workflow rejected:", error instanceof Error ? error.name : typeof error);
        return json({ error: "Invalid fixture workflow" }, 400);
      }
    }
    if (req.method === "GET" && path === "/api/chat-providers" && options.catalog) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.catalog));
      return;
    }
    if (req.method === "GET" && path === "/api/ai/provider-settings") {
      if (options.failSettingsRead?.()) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "settings unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(settings()));
      return;
    }
    if (req.method === "POST" && path === "/api/ai/provider-settings/actions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const mutation = ProviderSettingsMutationSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      if (mutation.type === "set_harness_enabled" || mutation.type === "logout_account") {
        const fingerprint = JSON.stringify(mutation);
        const duplicate = disableReceipts.get(mutation.idempotencyKey);
        if (duplicate !== undefined) {
          res.writeHead(duplicate === fingerprint ? 200 : 409, { "content-type": "application/json" });
          res.end(JSON.stringify(duplicate === fingerprint ? { kind: "snapshot", snapshot: settings() }
            : { error: { code: "idempotency_conflict", message: "Provider settings changed. Refresh and try again." } }));
          return;
        }
        const current = settings();
        if (mutation.expectedRevision !== current.revision) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "revision_conflict", message: "Provider settings changed. Refresh and try again." }, latestRevision: current.revision }));
          return;
        }
        if (current.revision >= 1_000_000_000) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "fixture revision limit reached" }));
          return;
        }
        if (mutation.type === "set_harness_enabled") {
          if (!current.harnesses.some(harness => harness.id === mutation.harnessInstanceId)
            || (!(mutation.harnessInstanceId in enabledOverrides) && Object.keys(enabledOverrides).length >= 32)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unsupported fixture target" }));
            return;
          }
          enabledOverrides[mutation.harnessInstanceId] = mutation.enabled;
        } else {
          if (!current.accounts.some(account => account.id === mutation.accountId)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unsupported fixture target" }));
            return;
          }
          authenticated = false;
        }
        committedRevision = current.revision + 1;
        workflowEvents.push(mutation.type === "logout_account" ? "logout" : mutation.enabled ? "agent-enabled" : "agent-disabled");
        if (disableReceipts.size >= 32) disableReceipts.delete(disableReceipts.keys().next().value!);
        disableReceipts.set(mutation.idempotencyKey, fingerprint);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ kind: "snapshot", snapshot: settings() }));
        return;
      }
      if (mutation.type !== "start_login") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported fixture action" }));
        return;
      }
      const summary = claudeSummary(authenticated);
      const action = providerAuthActions(summary)[0];
      if (!action || action.kind !== "foreground_terminal") throw new Error("Missing Claude fixture action");
      const authorization = req.headers.authorization ?? "";
      const workspaces = await fetch(`${upstream.url}/api/terminal/workspaces`, {
        headers: { authorization },
        signal: AbortSignal.timeout(10_000),
      })
        .then((response) => response.json()) as { workspaces: Array<{ id: string }> };
      const workspaceId = workspaces.workspaces[0]?.id;
      if (!workspaceId) throw new Error("Missing fixture Terminal workspace");
      const command = { name: action.label, cwd: "projects", command: ["sh", "-lc", action.command] };
      commands.push(command);
      const tabResponse = await fetch(`${upstream.url}/api/terminal/workspaces/${workspaceId}/tabs`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      });
      const { tab } = await tabResponse.json() as { tab: { id: string } };
      const snapshot = settings();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        kind: "login_attempt",
        snapshot,
        attempt: {
          id: `fixture_${mutation.type}`,
          harnessInstanceId: "claude_harness",
          accountId: "claude_account",
          method: "terminal",
          state: "pending",
          action: { kind: "open_terminal", terminalSessionId: `${workspaceId}:${tab.id}` },
          expiresAt: "2026-09-20T01:00:00.000Z",
          safeFailure: null,
        },
      }));
      return;
    }
    if (req.url === "/api/coding-agents/summary") {
      const response = await fetch(`${upstream.url}${req.url}`, {
        headers: { authorization: req.headers.authorization ?? "" }, signal: AbortSignal.timeout(10_000),
      });
      const summary = await response.json() as { providers: AgentProviderSummary[] };
      const provider = claudeSummary(authenticated);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...summary, providers: [provider] }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/tabs")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      commands.push(JSON.parse(body.toString()));
      const forward = request(`${upstream.url}${req.url}`, { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      forward.on("error", () => { res.writeHead(502); res.end(); });
      forward.end(body);
      return;
    }
    const forward = request(`${upstream.url}${req.url}`, { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    forward.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  server.on("upgrade", (req, socket, head) => {
    const target = connect(upstream.port, "127.0.0.1", () => {
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
    socket.on("close", () => target.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`, commands, workflowEvents,
    setAuthenticated(value: boolean) { authenticated = value; },
    async close() { startReceipts.clear(); disableReceipts.clear(); server.closeAllConnections(); await upstream.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function claudeSummary(authenticated: boolean): AgentProviderSummary {
  const provider: AgentProviderSummary = {
    id: "claude", kind: "claude", displayName: "Claude", installStatus: "installed",
    authStatus: authenticated ? "authenticated" : "missing",
    availability: authenticated ? "available" : "auth_required",
    supportedModes: ["default"], defaultMode: "default",
    setupActions: [{ id: "claude_connect", kind: "foreground_terminal", label: "Connect Claude", command: "claude auth login" }],
  };
  provider.setupActions = providerAuthActions(provider);
  return provider;
}
