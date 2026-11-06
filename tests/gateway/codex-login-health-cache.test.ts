import { expect, it, vi } from "vitest";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/thread-store";

it.each([
  { oldOk: false, newOk: true, want: "available" },
  { oldOk: true, newOk: false, want: "unavailable" },
])("fences old health=$oldOk after login and retains exact sibling owner/provider cache", async ({ oldOk, newOk, want }) => {
  let resolveOld!: (value: { ok: boolean }) => void;
  const oldHealth = new Promise<{ ok: boolean }>(resolve => { resolveOld = resolve; });
  const reads: string[] = [];
  function adapter(id: "codex" | "claude"): CodingAgentProviderAdapter {
    return { providerId: id,
      getSummary: () => ({ id, kind: id, displayName: id, availability: "available", installStatus: "installed",
        authStatus: id === "codex" ? "unknown" : "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [] }),
      startThread: () => [],
      healthCheck: ({ principal }) => {
        const key = `${principal.userId}:${id}`; reads.push(key);
        return key === "alice:codex" && reads.filter(value => value === key).length === 1 ? oldHealth : { ok: newOk };
      },
    };
  }
  const registry = createCodingAgentProviderRegistry({ providers: [adapter("codex"), adapter("claude")] });
  const alice = { userId: "alice", source: "jwt" as const }, bob = { userId: "alice:secondary", source: "jwt" as const };
  await registry.listProviders(bob);
  const beforeLogin = registry.listProviders(alice);
  await vi.waitFor(() => expect(reads).toContain("alice:codex"));
  registry.invalidate("alice", "codex");
  await expect(registry.listProviders(alice)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "codex", availability: want }),
  ]));
  resolveOld({ ok: oldOk }); await beforeLogin;
  await expect(registry.listProviders(alice)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "codex", availability: want }),
  ]));
  await registry.listProviders(bob);
  expect(reads.filter(key => key === "alice:codex")).toHaveLength(2);
  expect(reads.filter(key => key === "alice:claude")).toHaveLength(1);
  expect(reads.filter(key => key === "alice:secondary:codex")).toHaveLength(1);
  expect(reads.filter(key => key === "alice:secondary:claude")).toHaveLength(1);
});
