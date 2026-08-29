import { Server } from "@renderer/lib/hugeicons";
import { rebaseCustomMcpPolicy } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../stores/connection";

type AuthMode = "none" | "oauth" | "bearer" | "api_key";
interface Tool { name: string; description: string; inputSchema: unknown; approval: "always_ask" | "allow"; enabled: boolean }
interface McpServer { id: string; name: string; url: string; authMode: AuthMode; status: string; enabled: boolean; revision: number; tools: Tool[] }

function findMcpServer(servers: McpServer[], serverId: string): McpServer | undefined {
  return servers.find((server) => server.id === serverId);
}

export function McpServersSection() {
  const api = useConnection((state) => state.api);
  const [servers, setServers] = useState<McpServer[]>([]);
  const serversRef = useRef<McpServer[]>([]);
  const saveGenerationsRef = useRef<Record<string, number>>({});
  const saveWorkersRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("oauth");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replaceServers = useCallback((next: McpServer[]) => {
    serversRef.current = next;
    setServers(next);
  }, []);
  const load = useCallback(async () => {
    if (!api) { replaceServers([]); return; }
    replaceServers(await api.get<McpServer[]>("/api/mcp-servers"));
  }, [api, replaceServers]);
  useEffect(() => { void load().catch(() => setError("Could not load MCP servers.")); }, [load]);

  async function run(operation: () => Promise<unknown>) {
    if (!api) return;
    setBusy(true); setError(null);
    try { await operation(); await load(); }
    catch (operationError: unknown) {
      console.warn(
        "[custom-mcp] operation failed:",
        operationError instanceof Error ? operationError.message : String(operationError),
      );
      setError("The MCP operation failed. Check the server status and try again.");
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

  function queuePolicyUpdate(serverId: string, update: (server: McpServer) => McpServer): void {
    if (!api) return;
    updateLocalServer(serverId, update);
    saveGenerationsRef.current[serverId] = (saveGenerationsRef.current[serverId] ?? 0) + 1;
    if (saveWorkersRef.current[serverId]) return;
    setBusy(true);
    setError(null);
    const worker = (async () => {
      let rebaseAvailable = true;
      // react-doctor-disable-next-line react-hooks-js/todo -- the worker must always release its per-server refs and busy state, including on API failures.
      try {
        while (true) {
          const generation = saveGenerationsRef.current[serverId];
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
        console.warn(
          "[custom-mcp] policy save failed:",
          operationError instanceof Error ? operationError.message : String(operationError),
        );
        setError("The MCP policy could not be saved. Your local edits remain visible; retry the change.");
      } finally {
        delete saveWorkersRef.current[serverId];
        delete saveGenerationsRef.current[serverId];
        setBusy(false);
      }
    })();
    saveWorkersRef.current[serverId] = worker;
  }

  return <div className="space-y-5">
    <div className="flex items-start gap-3"><Server size={20} style={{ color: "var(--text-secondary)" }} /><div><h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>MCP servers</h3><p className="text-sm" style={{ color: "var(--text-secondary)" }}>Remote HTTPS servers brokered by Matrix. Credentials never enter your computer.</p></div></div>
    {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
    <div className="grid grid-cols-2 gap-2 rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <input aria-label="MCP server name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Server name" className="rounded-lg border bg-transparent px-3 py-2 text-sm" />
      <input aria-label="MCP server URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" maxLength={2048} className="rounded-lg border bg-transparent px-3 py-2 text-sm" />
      <select aria-label="Authentication mode" value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)} className="rounded-lg border bg-transparent px-3 py-2 text-sm"><option value="oauth">MCP OAuth</option><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="api_key">X-API-Key</option></select>
      {(authMode === "bearer" || authMode === "api_key") ? <input aria-label="MCP credential" type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Secret credential" maxLength={4096} className="rounded-lg border bg-transparent px-3 py-2 text-sm" /> : null}
      <button type="button" disabled={!api || busy || !name.trim() || !url.trim()} onClick={add} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">Add MCP server</button>
    </div>
    {!api ? <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>Connect a Matrix computer to manage MCP servers.</p> : null}
    {api && servers.length === 0 && !error ? <div className="rounded-xl border border-dashed p-6 text-center" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}><p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>No personal MCP servers yet</p><p className="mt-1 text-sm" style={{ color: "var(--text-tertiary)" }}>Add a remote HTTPS server above to discover and approve its tools.</p></div> : null}
    <div className="space-y-3">{servers.map((server) => <article key={server.id} className="rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">{server.name}</p><p className="text-xs" style={{ color: "var(--text-tertiary)" }}>{server.status} · {server.authMode} · revision {server.revision}</p></div><div className="flex gap-2">
        {server.authMode === "oauth" && server.status === "auth_required" ? <button type="button" className="text-xs underline" onClick={() => run(async () => { const result = await api!.post<{ url: string }>(`/api/mcp-servers/${server.id}/connect`, {}); window.open(result.url, "_blank", "noopener,noreferrer"); })}>Authorize</button> : null}
        <button type="button" className="text-xs underline" onClick={() => run(() => api!.post(`/api/mcp-servers/${server.id}/discover`, {}))}>Discover</button><button type="button" className="text-xs underline" onClick={() => run(() => api!.post(`/api/mcp-servers/${server.id}/test`, {}, { timeoutMs: 30_000 }))}>Test</button><button type="button" className="text-xs text-red-400 underline" onClick={() => run(() => api!.delete(`/api/mcp-servers/${server.id}`))}>Remove</button>
      </div></div>
      {server.tools.length ? <div className="mt-3 space-y-2">{server.tools.map((tool) => <div key={tool.name} className="flex items-center gap-3 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={tool.enabled} onChange={(event) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === tool.name ? { ...candidate, enabled: event.target.checked } : candidate) }))} />{tool.name}</label>{tool.description ? <span className="min-w-0 flex-1 truncate" title={tool.description} style={{ color: "var(--text-tertiary)" }}>{tool.description}</span> : null}<select aria-label={`${tool.name} approval`} disabled={!tool.enabled} value={tool.approval} onChange={(event) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === tool.name ? { ...candidate, approval: event.target.value as Tool["approval"] } : candidate) }))} className="rounded border bg-transparent px-2 py-1"><option value="always_ask">Always ask</option><option value="allow">Allow</option></select></div>)}<button type="button" disabled={!server.tools.some((tool) => tool.enabled)} onClick={() => queuePolicyUpdate(server.id, (current) => ({ ...current, enabled: !current.enabled }))} className="rounded border px-3 py-1 text-xs disabled:opacity-50">{server.enabled ? "Disable" : "Enable"}</button></div> : null}
    </article>)}</div>
  </div>;
}

export default McpServersSection;
