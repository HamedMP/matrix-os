import { MatrixMcpEndpointCard, McpConnectionInventory, McpCustomServerForm, McpRowAction, McpSectionHeading, McpServerDiagnostics, McpToolPolicyList, RemoteMcpPresetPicker, connectedMcpServices, customMcpErrorMessage, matrixMcpEndpointUrl } from "@matrix-os/ui";
import { Server } from "@renderer/lib/hugeicons";
import { CUSTOM_MCP_UNAVAILABLE, CUSTOM_MCP_UNAVAILABLE_MESSAGE, rebaseCustomMcpPolicy } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { McpCustomAuthMode } from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import { useConnection } from "../../stores/connection";
import { useRemoteMcpPresets } from "./use-remote-mcp-presets";

type AuthMode = McpCustomAuthMode;
interface Tool { name: string; description: string; inputSchema: unknown; approval: "always_ask" | "allow"; enabled: boolean }
interface McpServer { id: string; name: string; url: string; authMode: AuthMode; status: string; enabled: boolean; revision: number; tools: Tool[] }

function findMcpServer(servers: McpServer[], serverId: string): McpServer | undefined {
  return servers.find((server) => server.id === serverId);
}

function presetErrorMessage(error: unknown): string {
  return error instanceof AppError
    ? customMcpErrorMessage(error.httpStatus ?? 0, { code: error.detail })
    : "The MCP operation failed. Check the server status and try again.";
}

export function McpServersSection() {
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const [servers, setServers] = useState<McpServer[]>([]);
  const { presets, catalogState, loadCatalog, inventoryFor } = useRemoteMcpPresets(api);
  const [connectingPreset, setConnectingPreset] = useState<string | null>(null);
  const serversRef = useRef<McpServer[]>([]);
  const saveGenerationsRef = useRef<Record<string, number>>({});
  const saveWorkersRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("oauth");
  const [credential, setCredential] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [busy, setBusy] = useState(false);
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
    try {
      if (!api) { replaceServers([]); return; }
      replaceServers(await api.get<McpServer[]>("/api/mcp-servers"));
      setLoaded(true);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof AppError && loadError.detail === CUSTOM_MCP_UNAVAILABLE
        ? CUSTOM_MCP_UNAVAILABLE_MESSAGE : "Could not load MCP servers.");
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, [api, replaceServers]);
  const retryLoad = useCallback(() => {
    void load().catch((loadError: unknown) => {
      console.warn("[custom-mcp] load failed:", loadError instanceof Error ? loadError.name : typeof loadError);
    });
  }, [load]);
  useEffect(() => { retryLoad(); }, [retryLoad]);
  function authorize(serverId: string) {
    return run(async () => {
      const result = await api!.post<{ url: string }>(`/api/mcp-servers/${serverId}/connect`, {});
      window.open(result.url, "_blank", "noopener,noreferrer");
    });
  }

  async function connectPreset(presetId: string) {
    if (!api) return;
    setBusy(true); setConnectingPreset(presetId); setError(null);
    try {
      const created = await api.post<McpServer>("/api/mcp-servers", { catalogId: presetId });
      if (created.authMode === "oauth") {
        const connected = await api.post<{ url: string }>(`/api/mcp-servers/${created.id}/connect`, {});
        window.open(connected.url, "_blank", "noopener,noreferrer");
      }
      await load();
    } catch (connectError: unknown) {
      console.warn("[custom-mcp] preset connect failed:", connectError instanceof AppError ? connectError.httpStatus : connectError instanceof Error ? connectError.name : typeof connectError);
      setError(presetErrorMessage(connectError));
    } finally {
      setBusy(false); setConnectingPreset(null);
    }
  }

  async function run(operation: () => Promise<unknown>) {
    if (!api) return;
    setBusy(true); setError(null);
    try { await operation(); await load(); }
    catch (operationError: unknown) {
      console.warn(
        "[custom-mcp] operation failed:",
        operationError instanceof AppError ? operationError.httpStatus : operationError instanceof Error ? operationError.name : typeof operationError,
      );
      setError(presetErrorMessage(operationError));
    }
    finally { setBusy(false); }
  }

  async function add() {
    if (!api || !name.trim() || !url.trim()) return;
    setBusy(true); setError(null);
    try {
      const created = await api.post<McpServer>("/api/mcp-servers", {
        name: name.trim(), url: url.trim(), authMode,
        ...((authMode === "bearer" || authMode === "api_key") ? { credential } : {}),
      });
      setName(""); setUrl(""); setCredential("");
      if (created.authMode === "oauth") {
        const connected = await api.post<{ url: string }>(`/api/mcp-servers/${created.id}/connect`, {});
        window.open(connected.url, "_blank", "noopener,noreferrer");
      }
      await load();
    } catch (addError: unknown) {
      console.warn(
        "[custom-mcp] add failed:",
        addError instanceof Error ? addError.message : String(addError),
      );
      setError("Could not add the MCP server.");
    }
    finally { setBusy(false); }
  }

  function updateLocalServer(serverId: string, update: (server: McpServer) => McpServer): void {
    replaceServers(serversRef.current.map((server) => server.id === serverId ? update(server) : server));
  }

  function startPolicyWorker(serverId: string): void {
    if (!api || saveWorkersRef.current[serverId]) return;
    setBusy(true);
    setError(null);
    let attemptedGeneration = -1;
    let retryNewerEdit = false;
    const worker = (async () => {
      let rebaseAvailable = true;
      // react-doctor-disable-next-line react-hooks-js/todo -- the worker must always release its per-server refs and busy state, including on API failures.
      try {
        while (true) {
          const generation = saveGenerationsRef.current[serverId];
          if (generation === undefined) return;
          attemptedGeneration = generation;
          const desired = findMcpServer(serversRef.current, serverId);
          if (!desired) return;
          let updated: McpServer;
          try {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- revisioned policy writes must be serialized; parallel writes would race on the same optimistic revision.
            updated = await api.patch<McpServer>(`/api/mcp-servers/${serverId}`, {
              revision: desired.revision,
              enabled: desired.enabled,
              tools: desired.tools.map((tool) => ({ name: tool.name, enabled: tool.enabled, approval: tool.approval })),
            });
          } catch (patchError: unknown) {
            // react-doctor-disable-next-line react-hooks-js/todo -- a bounded second failure exits through the worker's safe error handler.
            if (!rebaseAvailable) throw patchError;
            const authoritative = findMcpServer(await api.get<McpServer[]>("/api/mcp-servers"), serverId);
            // react-doctor-disable-next-line react-hooks-js/todo -- a removed server exits through the same safe error handler without discarding local state first.
            if (!authoritative) throw patchError;
            updateLocalServer(serverId, (current) => rebaseCustomMcpPolicy(authoritative, current));
            rebaseAvailable = false;
            continue;
          }
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
        setError("The MCP policy could not be saved. Your local edits remain visible; retry the change.");
      } finally {
        delete saveWorkersRef.current[serverId];
        if (retryNewerEdit) {
          startPolicyWorker(serverId);
        } else {
          delete saveGenerationsRef.current[serverId];
          setBusy(false);
        }
      }
    })();
    saveWorkersRef.current[serverId] = worker;
  }

  function queuePolicyUpdate(serverId: string, update: (server: McpServer) => McpServer): void {
    if (!api) return;
    updateLocalServer(serverId, update);
    saveGenerationsRef.current[serverId] = (saveGenerationsRef.current[serverId] ?? 0) + 1;
    startPolicyWorker(serverId);
  }

  const inventory = inventoryFor(servers);
  const connectedServices = connectedMcpServices(inventory);

  return <div className="space-y-8">
    <div className="flex items-start gap-3"><Server size={20} style={{ color: "var(--text-secondary)" }} /><div><h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>MCP servers</h3><p className="text-sm" style={{ color: "var(--text-secondary)" }}>Connect your tools once. Every agent in Matrix can use them, and so can any MCP client you sign in with Matrix. Credentials never enter your computer.</p></div></div>
    {error ? (
      <div className="flex items-center gap-3">
        <p role="alert" className="text-sm" style={{ color: "var(--text-secondary)" }}>{error}</p>
        {!loaded ? (
          <button
            type="button"
            onClick={retryLoad}
            disabled={loading || busy || !api}
            className="min-h-9 rounded-md border px-3 text-sm hover:brightness-105 active:opacity-80 disabled:opacity-50"
          >
            Retry
          </button>
        ) : null}
      </div>
    ) : null}
    {loading ? <p role="status" className="text-sm" style={{ color: "var(--text-tertiary)" }}>Loading MCP servers…</p> : null}
    <MatrixMcpEndpointCard endpointUrl={matrixMcpEndpointUrl(platformHost)} connectedServices={connectedServices} />
    <fieldset disabled={!loaded || loading || !api || diagnosing} className="min-w-0 space-y-8">
    {!api ? <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>Connect a Matrix computer to manage MCP servers.</p> : null}
    {api && loaded && (servers.length > 0 || !error) ? <section className="space-y-3">
      <McpSectionHeading title="Your connections" count={inventory.length || undefined} description="Choose which tools agents and clients may use." />
      <McpConnectionInventory
      entries={inventory}
      renderActions={(entry) => {
        const server = findMcpServer(servers, entry.id);
        if (!server) return null;
        return <>
          {server.authMode === "oauth" && server.status === "auth_required" ? <McpRowAction tone="primary" onClick={() => { void authorize(server.id); }}>Authorize</McpRowAction> : null}
          <McpRowAction tone="danger" onClick={() => run(() => api!.delete(`/api/mcp-servers/${server.id}`))}>Remove</McpRowAction>
        </>;
      }}
      renderDetails={(entry) => {
        const server = findMcpServer(servers, entry.id);
        if (!server) return null;
        return <>
      <McpServerDiagnostics disabled={busy || !api} onPendingChange={setDiagnosing} onDiscovered={load}
        request={(action) => api!.post(`/api/mcp-servers/${server.id}/${action}`, {}, { timeoutMs: 30_000 })} />
      <McpToolPolicyList tools={server.tools} serverEnabled={server.enabled}
        onToolEnabledChange={(toolName, enabled) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === toolName ? { ...candidate, enabled } : candidate) }))}
        onToolApprovalChange={(toolName, approval) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === toolName ? { ...candidate, approval } : candidate) }))}
        onToggleServer={() => queuePolicyUpdate(server.id, (current) => ({ ...current, enabled: !current.enabled }))} />
        </>;
      }} /></section> : null}
    <section className="space-y-3">
      <McpSectionHeading title="Add services" description="Each service you connect joins your Matrix MCP. Sign in with the service; Matrix keeps the credentials." />
      <RemoteMcpPresetPicker presets={presets} state={catalogState} connections={servers.map((server) => ({ serverId: server.id, url: server.url, status: server.status }))}
        connectingId={connectingPreset} disabled={busy} onConnect={(presetId) => { void connectPreset(presetId); }} onFinishSignIn={(serverId) => { void authorize(serverId); }} onRetry={loadCatalog} />
    </section>
    <McpCustomServerForm name={name} url={url} authMode={authMode} credential={credential}
      onNameChange={setName} onUrlChange={setUrl} onAuthModeChange={setAuthMode} onCredentialChange={setCredential}
      canSubmit={Boolean(api) && !busy && Boolean(name.trim()) && Boolean(url.trim())} onSubmit={() => { void add(); }} />
    </fieldset>
  </div>;
}

export default McpServersSection;
