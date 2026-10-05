import type {
  MemoryWorkspaceClient,
  MemoryImportSource,
  MemorySource,
  MemorySnapshot,
  MemorySearchResult,
} from "./model.js";
export type MemoryTransport = {
  request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T>;
};
/** Transport owns runtime routing and authentication. UI never accepts engine URLs. */
export function createMemoryWorkspaceClient(
  transport: MemoryTransport,
): MemoryWorkspaceClient {
  const base = "/api/memory-workspace";
  return {
    snapshot: (options = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options))
        if (value !== undefined && value !== "") params.set(key, String(value));
      return transport.request<MemorySnapshot>(
        "GET",
        params.size ? `${base}?${params}` : base,
      );
    },
    getSource: async (id) =>
      (
        await transport.request<{ source: MemorySource }>(
          "GET",
          `${base}/sources/${encodeURIComponent(id)}`,
        )
      ).source,
    importSources: (sources: MemoryImportSource[], clientRequestId: string) =>
      transport.request("POST", `${base}/sources`, {
        sources,
        clientRequestId,
      }),
    updateSource: async (id, changes) =>
      (
        await transport.request<{ source: MemorySource }>(
          "PATCH",
          `${base}/sources/${encodeURIComponent(id)}`,
          changes,
        )
      ).source,
    deleteSource: async (id) => {
      await transport.request(
        "DELETE",
        `${base}/sources/${encodeURIComponent(id)}`,
      );
    },
    search: (query, engine) =>
      transport.request<MemorySearchResult>("POST", `${base}/search`, {
        query,
        engine,
        limit: 10,
      }),
    compare: (query) =>
      transport.request("POST", `${base}/compare`, { query, limit: 10 }),
    actJob: async (id, action) => {
      await transport.request(
        "POST",
        `${base}/jobs/${encodeURIComponent(id)}/action`,
        { action },
      );
    },
  };
}
