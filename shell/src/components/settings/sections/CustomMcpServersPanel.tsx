"use client";

import { rebaseCustomMcpPolicy } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

type AuthMode = "none" | "oauth" | "bearer" | "api_key";
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
  status: string;
  enabled: boolean;
  revision: number;
  tools: McpTool[];
}

const GATEWAY = getGatewayUrl();

async function fetchMcpServers(): Promise<McpServer[]> {
  const response = await fetch(`${GATEWAY}/api/mcp-servers`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Custom MCP unavailable");
  return response.json() as Promise<McpServer[]>;
}

function findMcpServer(servers: McpServer[], serverId: string): McpServer | undefined {
  return servers.find((server) => server.id === serverId);
}

export function CustomMcpServersPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const serversRef = useRef<McpServer[]>([]);
  const saveGenerationsRef = useRef<Record<string, number>>({});
  const saveWorkersRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("oauth");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const replaceServers = useCallback((next: McpServer[]) => {
    serversRef.current = next;
    setServers(next);
  }, []);
  const load = useCallback(async () => {
    replaceServers(await fetchMcpServers());
  }, [replaceServers]);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount-time external data load; state is updated only in the promise rejection callback after the gateway request settles.
    void load().catch((loadError: unknown) => {
      console.warn(
        "[custom-mcp] load failed:",
        loadError instanceof Error ? loadError.message : String(loadError),
      );
      setError("Could not load Custom MCP servers.");
    });
  }, [load]);

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
      if (!response.ok) throw new Error("Request failed");
      const result = await response.json() as T;
      await load();
      return result;
    } catch (operationError: unknown) {
      console.warn(
        "[custom-mcp] operation failed:",
        operationError instanceof Error ? operationError.message : String(operationError),
      );
      setError("The Custom MCP operation failed. Check the server status and try again.");
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

  function updateLocalServer(serverId: string, update: (server: McpServer) => McpServer): void {
    replaceServers(serversRef.current.map((server) => server.id === serverId ? update(server) : server));
  }

  function queuePolicyUpdate(serverId: string, update: (server: McpServer) => McpServer): void {
    updateLocalServer(serverId, update);
    saveGenerationsRef.current[serverId] = (saveGenerationsRef.current[serverId] ?? 0) + 1;
    if (saveWorkersRef.current[serverId]) return;
    setBusy(serverId);
    setError(null);
    const worker = (async () => {
      let rebaseAvailable = true;
      // react-doctor-disable-next-line react-hooks-js/todo -- the worker must always release its per-server refs and busy state, including on fetch and parse failures.
      try {
        while (true) {
          const generation = saveGenerationsRef.current[serverId];
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
        console.warn(
          "[custom-mcp] policy save failed:",
          operationError instanceof Error ? operationError.message : String(operationError),
        );
        setError("The Custom MCP policy could not be saved. Your local edits remain visible; retry the change.");
      } finally {
        delete saveWorkersRef.current[serverId];
        delete saveGenerationsRef.current[serverId];
        setBusy(null);
      }
    })();
    saveWorkersRef.current[serverId] = worker;
  }

  return (
    <section className="space-y-4 border-t border-border/60 pt-8">
      <div>
        <h3 className="text-sm font-medium">Personal Custom MCP servers</h3>
        <p className="mt-1 text-sm text-muted-foreground">Remote HTTPS Streamable HTTP servers only. Credentials stay in the Matrix platform broker.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="grid gap-2 rounded-lg border border-border/60 bg-card/50 p-4 sm:grid-cols-2">
        <input aria-label="MCP server name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Server name" maxLength={100} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <input aria-label="MCP server URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" maxLength={2048} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <select aria-label="Authentication mode" value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="oauth">MCP OAuth</option><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="api_key">X-API-Key</option>
        </select>
        {(authMode === "bearer" || authMode === "api_key") && <input aria-label="MCP credential" type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Secret credential" maxLength={4096} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />}
        <button type="button" disabled={busy !== null || !name.trim() || !url.trim()} onClick={createServer} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Add MCP server</button>
      </div>
      <div className="space-y-3">
        {servers.length === 0 && !error ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-6 text-center">
            <p className="text-sm font-medium">No personal MCP servers yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Add a remote HTTPS server above to discover and approve its tools.</p>
          </div>
        ) : null}
        {servers.map((server) => (
          <article key={server.id} className="rounded-lg border border-border/60 bg-card/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-sm font-medium">{server.name}</p><p className="text-xs text-muted-foreground">{server.status} · {server.authMode} · revision {server.revision}</p></div>
              <div className="flex gap-2">
                {server.authMode === "oauth" && server.status === "auth_required" && <button type="button" className="text-xs underline" onClick={async () => { const result = await mutate<{ url: string }>(server.id, `/api/mcp-servers/${server.id}/connect`, "POST"); if (result?.url) window.open(result.url, "_blank", "noopener,noreferrer"); }}>Authorize</button>}
                <button type="button" className="text-xs underline" onClick={() => mutate(server.id, `/api/mcp-servers/${server.id}/discover`, "POST")}>Discover</button>
                <button type="button" className="text-xs underline" onClick={() => mutate(server.id, `/api/mcp-servers/${server.id}/test`, "POST")}>Test</button>
                <button type="button" className="text-xs text-red-400 underline" onClick={() => mutate(server.id, `/api/mcp-servers/${server.id}`, "DELETE")}>Remove</button>
              </div>
            </div>
            {server.tools.length > 0 && <div className="mt-3 space-y-2">
              {server.tools.map((tool) => <div key={tool.name} className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2"><input type="checkbox" checked={tool.enabled} onChange={(event) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === tool.name ? { ...candidate, enabled: event.target.checked } : candidate) }))} />{tool.name}</label>
                {tool.description ? <span className="min-w-0 flex-1 truncate text-muted-foreground" title={tool.description}>{tool.description}</span> : null}
                <select aria-label={`${tool.name} approval`} value={tool.approval} disabled={!tool.enabled} onChange={(event) => queuePolicyUpdate(server.id, (current) => ({ ...current, tools: current.tools.map((candidate) => candidate.name === tool.name ? { ...candidate, approval: event.target.value as McpTool["approval"] } : candidate) }))} className="rounded border border-border bg-background px-2 py-1"><option value="always_ask">Always ask</option><option value="allow">Allow</option></select>
              </div>)}
              <button type="button" disabled={!server.tools.some((tool) => tool.enabled)} onClick={() => queuePolicyUpdate(server.id, (current) => ({ ...current, enabled: !current.enabled }))} className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50">{server.enabled ? "Disable" : "Enable"}</button>
            </div>}
          </article>
        ))}
      </div>
    </section>
  );
}
