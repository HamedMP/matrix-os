"use client";

import {
  MatrixMcpEndpointCard,
  McpConnectionInventory,
  McpCustomServerForm,
  McpRowAction,
  McpSectionHeading,
  McpServerDiagnostics,
  McpToolPolicyList,
  connectedMcpServices,
  matrixMcpEndpointUrl,
  RemoteMcpPresetPicker,
  buildMcpConnectionInventory,
  customMcpErrorMessage,
  parseRemoteMcpCatalog,
  type RemoteMcpPreset,
} from "@matrix-os/ui";
import type { ConnectedService } from "./integrations-helpers";

import { CUSTOM_MCP_UNAVAILABLE, CUSTOM_MCP_UNAVAILABLE_MESSAGE, rebaseCustomMcpPolicy } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayUrl } from "@/lib/gateway";

type AuthMode = "none" | "oauth" | "bearer" | "api_key";
type McpStatus = "pending" | "auth_required" | "ready" | "degraded" | "disabled" | "action_required";
interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  approval: "always_ask" | "allow";
  enabled: boolean;
}
interface McpServer {
  id: string;
  name: string;
  url: string;
  authMode: AuthMode;
  status: McpStatus;
  enabled: boolean;
  revision: number;
  tools: McpTool[];
}

const GATEWAY = getGatewayUrl();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === "none" || value === "oauth" || value === "bearer" || value === "api_key";
}

function isMcpStatus(value: unknown): value is McpStatus {
  return value === "pending"
    || value === "auth_required"
    || value === "ready"
    || value === "degraded"
    || value === "disabled"
    || value === "action_required";
}

function isMcpTool(value: unknown): value is McpTool {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && typeof value.description === "string"
    && Object.hasOwn(value, "inputSchema")
    && (value.approval === "always_ask" || value.approval === "allow")
    && typeof value.enabled === "boolean";
}

function isMcpServer(value: unknown): value is McpServer {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.url === "string"
    && isAuthMode(value.authMode)
    && isMcpStatus(value.status)
    && typeof value.enabled === "boolean"
    && Number.isSafeInteger(value.revision)
    && Array.isArray(value.tools)
    && value.tools.every(isMcpTool);
}

async function fetchMcpServers(): Promise<McpServer[]> {
  const response = await fetch(`${GATEWAY}/api/mcp-servers`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    if (response.status === 503) {
      const body: unknown = await response.json();
      if (isRecord(body) && body.error === CUSTOM_MCP_UNAVAILABLE) throw new Error(CUSTOM_MCP_UNAVAILABLE);
    }
    throw new Error("Custom MCP request failed");
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isMcpServer)) {
    throw new Error("Invalid Custom MCP response");
  }
  return payload;
}

async function fetchMcpCatalog(): Promise<RemoteMcpPreset[]> {
  const response = await fetch(`${GATEWAY}/api/mcp-servers/catalog`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("MCP catalog request failed");
  return parseRemoteMcpCatalog(await response.json());
}

class CustomMcpRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super("Custom MCP request failed");
    this.name = "CustomMcpRequestError";
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const subscribeToNothing = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => null;

function findMcpServer(servers: McpServer[], serverId: string): McpServer | undefined {
  return servers.find((server) => server.id === serverId);
}

export function CustomMcpServersPanel({ connectedApps = [], appNames = {} }: {
  /** Legacy Pipedream connections, shown read-only in the same inventory. */
  connectedApps?: readonly ConnectedService[];
  appNames?: Readonly<Record<string, string>>;
} = {}) {
  const platformOrigin = useSyncExternalStore(subscribeToNothing, browserOrigin, serverOrigin);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<RemoteMcpPreset[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const serversRef = useRef<McpServer[]>([]);
  const saveGenerationsRef = useRef<Record<string, number>>({});
  const saveWorkersRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("oauth");
  const [credential, setCredential] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const replaceServers = useCallback((next: McpServer[]) => {
    serversRef.current = next;
    setServers(next);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setLoaded(false);
    // react-doctor-disable-next-line react-hooks-js/todo -- finally clears loading on both rejected requests and successful retries; keep the cleanup guarantee when the compiler skips this callback.
    try {
      replaceServers(await fetchMcpServers());
      setLoaded(true);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error && loadError.message === CUSTOM_MCP_UNAVAILABLE
        ? CUSTOM_MCP_UNAVAILABLE_MESSAGE : "Could not load Custom MCP servers.");
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, [replaceServers]);
  const retryLoad = useCallback(() => {
    void load().catch((loadError: unknown) => {
      console.warn("[custom-mcp] load failed:", loadError instanceof Error ? loadError.name : typeof loadError);
    });
  }, [load]);
  // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount loads the external server list; load also owns the flags for user-triggered retries.
  useEffect(() => { retryLoad(); }, [retryLoad]);
  const loadCatalog = useCallback(() => {
    setCatalogState("loading");
    void fetchMcpCatalog().then((next) => {
      setPresets(next);
      setCatalogState("ready");
    }, (catalogError: unknown) => {
      console.warn("[custom-mcp] catalog load failed:", catalogError instanceof Error ? catalogError.name : typeof catalogError);
      setCatalogState("error");
    });
  }, []);
  // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount loads the external preset catalog; the same callback serves Retry.
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  async function mutate<T>(id: string, path: string, method: "POST" | "PATCH" | "DELETE", body: unknown = {}) {
    setBusy(id);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- try/finally is required so every async exit clears the per-server busy state.
    try {
      const response = await fetch(`${GATEWAY}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(path.endsWith("/test") ? 30_000 : 10_000),
      });
      // react-doctor-disable-next-line react-hooks-js/todo -- this error enters the local catch so every mutation failure gets safe UI state and finally clears the busy flag.
      if (!response.ok) throw new CustomMcpRequestError(response.status, await readErrorBody(response));
      const result = await response.json() as T;
      await load();
      return result;
    } catch (operationError: unknown) {
      console.warn(
        "[custom-mcp] operation failed:",
        operationError instanceof CustomMcpRequestError ? operationError.status : operationError instanceof Error ? operationError.name : typeof operationError,
      );
      setError(operationError instanceof CustomMcpRequestError
        ? customMcpErrorMessage(operationError.status, operationError.body)
        : "The Custom MCP operation failed. Check the server status and try again.");
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function createServer() {
    if (!name.trim() || !url.trim()) return;
    const created = await mutate<McpServer>("create", "/api/mcp-servers", "POST", {
      name: name.trim(),
      url: url.trim(),
      authMode,
      ...((authMode === "bearer" || authMode === "api_key") ? { credential } : {}),
    });
    if (!created) return;
    setName(""); setUrl(""); setCredential("");
    if (created.authMode === "oauth") {
      const connected = await mutate<{ url: string }>(created.id, `/api/mcp-servers/${created.id}/connect`, "POST");
      if (connected?.url) window.open(connected.url, "_blank", "noopener,noreferrer,width=640,height=760");
    }
  }

  async function authorize(serverId: string) {
    const result = await mutate<{ url: string }>(serverId, `/api/mcp-servers/${serverId}/connect`, "POST");
    if (result?.url) window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function connectPreset(presetId: string) {
    const created = await mutate<McpServer>(`preset:${presetId}`, "/api/mcp-servers", "POST", { catalogId: presetId });
    if (created?.authMode !== "oauth") return;
    const connected = await mutate<{ url: string }>(created.id, `/api/mcp-servers/${created.id}/connect`, "POST");
    if (connected?.url) window.open(connected.url, "_blank", "noopener,noreferrer,width=640,height=760");
  }

  function updateLocalServer(serverId: string, update: (server: McpServer) => McpServer): void {
    replaceServers(serversRef.current.map((server) => server.id === serverId ? update(server) : server));
  }

  function startPolicyWorker(serverId: string): void {
    if (saveWorkersRef.current[serverId]) return;
    setBusy(serverId);
    setError(null);
    let attemptedGeneration = -1;
    let retryNewerEdit = false;
    const worker = (async () => {
      let rebaseAvailable = true;
      // react-doctor-disable-next-line react-hooks-js/todo -- the worker must always release its per-server refs and busy state, including on fetch and parse failures.
      try {
        while (true) {
          const generation = saveGenerationsRef.current[serverId];
          if (generation === undefined) return;
          attemptedGeneration = generation;
          const desired = findMcpServer(serversRef.current, serverId);
          if (!desired) return;
          const response = await fetch(`${GATEWAY}/api/mcp-servers/${serverId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              revision: desired.revision,
              enabled: desired.enabled,
              tools: desired.tools.map(({ name: toolName, enabled, approval }) => ({ name: toolName, enabled, approval })),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            // react-doctor-disable-next-line react-hooks-js/todo -- a bounded second failure exits through the worker's safe error handler.
            if (!rebaseAvailable) throw new Error("Request failed");
            const authoritative = findMcpServer(await fetchMcpServers(), serverId);
            // react-doctor-disable-next-line react-hooks-js/todo -- a removed server exits through the same safe error handler without discarding local state first.
            if (!authoritative) throw new Error("Request failed");
            updateLocalServer(serverId, (current) => rebaseCustomMcpPolicy(authoritative, current));
            rebaseAvailable = false;
            continue;
          }
          const updated = await response.json() as McpServer;
          rebaseAvailable = true;
          updateLocalServer(serverId, (current) => ({
            ...updated,
            enabled: current.enabled,
            tools: current.tools,
          }));
          if (saveGenerationsRef.current[serverId] === generation) return;
        }
      } catch (operationError: unknown) {
        retryNewerEdit = (saveGenerationsRef.current[serverId] ?? -1) > attemptedGeneration;
        console.warn(
          "[custom-mcp] policy save failed:",
          operationError instanceof Error ? operationError.message : String(operationError),
        );
        setError("The Custom MCP policy could not be saved. Your local edits remain visible; retry the change.");
      } finally {
        delete saveWorkersRef.current[serverId];
        if (retryNewerEdit) {
          startPolicyWorker(serverId);
        } else {
          delete saveGenerationsRef.current[serverId];
          setBusy(null);
        }
      }
    })();
    saveWorkersRef.current[serverId] = worker;
  }

  function queuePolicyUpdate(serverId: string, update: (server: McpServer) => McpServer): void {
    updateLocalServer(serverId, update);
    saveGenerationsRef.current[serverId] = (saveGenerationsRef.current[serverId] ?? 0) + 1;
    startPolicyWorker(serverId);
  }

  const inventory = buildMcpConnectionInventory(servers, connectedApps, appNames);
  const serverById = new Map(servers.map((server) => [server.id, server]));

  const connectedServices = connectedMcpServices(inventory);

  return (
    <section className="space-y-8 border-t border-border/60 pt-8">
      <div>
        <h3 className="text-sm font-medium">MCP servers</h3>
        <p className="mt-1 text-sm text-muted-foreground">Connect your tools once. Every agent in Matrix can use them, and so can any MCP client you sign in with Matrix. Credentials stay in the Matrix platform broker.</p>
      </div>
      {error ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-muted-foreground">{error}</p>
          {!loaded ? (
            <button
              type="button"
              onClick={retryLoad}
              disabled={loading || busy !== null}
              className="min-h-9 rounded-md border border-border px-3 text-sm hover:bg-muted active:opacity-80 disabled:opacity-50"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading MCP servers…</p>}
      <MatrixMcpEndpointCard endpointUrl={matrixMcpEndpointUrl(platformOrigin)} connectedServices={connectedServices} />
      <fieldset disabled={!loaded || loading || diagnosing} className="min-w-0 space-y-8">
      {loaded && (inventory.length > 0 || !error) ? <div className="space-y-3">
        <McpSectionHeading title="Your connections" count={inventory.length || undefined} description="Choose which tools agents and clients may use." />
        <McpConnectionInventory entries={inventory}
        renderActions={(entry) => {
          const server = serverById.get(entry.id);
          if (!server) return null;
          return (
            <>
              {server.authMode === "oauth" && server.status === "auth_required" && <McpRowAction tone="primary" onClick={() => { void authorize(server.id); }}>Authorize</McpRowAction>}
              <McpRowAction tone="danger" onClick={() => mutate(server.id, `/api/mcp-servers/${server.id}`, "DELETE")}>Remove</McpRowAction>
            </>
          );
        }}
        renderDetails={(entry) => {
          const server = serverById.get(entry.id);
          if (!server) return null;
          return (
            <>
              <McpServerDiagnostics disabled={busy !== null} onPendingChange={setDiagnosing} onDiscovered={load}
                request={async (action) => {
                  const response = await fetch(`${GATEWAY}/api/mcp-servers/${server.id}/${action}`, {
                    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
                    signal: AbortSignal.timeout(30_000),
                  });
                  if (!response.ok) throw new Error("MCP diagnostic failed");
                  return response.json();
                }} />
              <McpToolPolicyList tools={server.tools} serverEnabled={server.enabled}
                onToolEnabledChange={(toolName, enabled) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === toolName ? { ...candidate, enabled } : candidate) }))}
                onToolApprovalChange={(toolName, approval) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === toolName ? { ...candidate, approval } : candidate) }))}
                onToggleServer={() => queuePolicyUpdate(server.id, (current) => ({ ...current, enabled: !current.enabled }))} />
            </>
          );
        }} /></div> : null}
      <div className="space-y-3">
        <McpSectionHeading title="Add services" description="Each service you connect joins your Matrix MCP. Sign in with the service; Matrix keeps the credentials." />
        <RemoteMcpPresetPicker presets={presets} state={catalogState} connections={servers.map((server) => ({ serverId: server.id, url: server.url, status: server.status }))}
          connectingId={busy?.startsWith("preset:") ? busy.slice("preset:".length) : null} disabled={busy !== null}
          onConnect={(presetId) => { void connectPreset(presetId); }} onFinishSignIn={(serverId) => { void authorize(serverId); }} onRetry={loadCatalog} />
      </div>
      <McpCustomServerForm name={name} url={url} authMode={authMode} credential={credential}
        onNameChange={setName} onUrlChange={setUrl} onAuthModeChange={setAuthMode} onCredentialChange={setCredential}
        canSubmit={busy === null && Boolean(name.trim()) && Boolean(url.trim())} onSubmit={() => { void createServer(); }} />
      </fieldset>
    </section>
  );
}
