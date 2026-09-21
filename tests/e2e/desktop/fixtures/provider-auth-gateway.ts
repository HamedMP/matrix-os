import { createServer, request } from "node:http";
import { connect } from "node:net";
import { startStubGateway } from "./stub-gateway";
import { providerAuthActions } from "../../../../packages/gateway/src/coding-agents/provider-auth-actions";
import {
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  type AgentProviderSummary,
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
    supportedActions: [authenticated ? "logout_account" : "start_login"],
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
export async function startProviderAuthGateway() {
  const upstream = await startStubGateway();
  let authenticated = false;
  const commands: unknown[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/api/ai/provider-settings") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(providerAuthSettingsSnapshot(authenticated)));
      return;
    }
    if (req.method === "POST" && path === "/api/ai/provider-settings/actions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const mutation = ProviderSettingsMutationSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      if (mutation.type !== "start_login" && mutation.type !== "logout_account") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported fixture action" }));
        return;
      }
      if (mutation.type === "logout_account") {
        authenticated = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          kind: "snapshot",
          snapshot: providerAuthSettingsSnapshot(authenticated),
        }));
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
      const snapshot = providerAuthSettingsSnapshot(authenticated);
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
    url: `http://127.0.0.1:${address.port}`, commands,
    setAuthenticated(value: boolean) { authenticated = value; },
    async close() { server.closeAllConnections(); await upstream.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
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
