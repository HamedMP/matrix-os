import { vi } from "vitest";
/** Existing transcript tests exercise an explicitly unsupported navigation API. */
export function stubLegacyChatFetch(fetchFn: unknown): void {
  const transport = fetchFn as typeof fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/chats/navigation?")) {
      return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    }
    if (/\/api\/chat-agents(?:\?|$)/.test(path)) {
      return Promise.resolve(Response.json({ enabled: true, agents: [] }));
    }
    if (/\/api\/chats\/[^/?]+\/bot(?:\?|$)/.test(path)) {
      return Promise.resolve(Response.json({ agentId: null }));
    }
    return transport(input, init);
  });
}
