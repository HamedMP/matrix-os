import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createClaudeModelCatalogSource } from "../../packages/gateway/src/chat/claude-model-catalog.js";

const principal = { userId: "owner_catalog_errors", source: "jwt" as const };
const provider = { id: "claude", kind: "claude", availability: "available" } as AgentProviderSummary;
const inventory = [{ value: "claude-fable-5", displayName: "Fable" }];

describe("Claude metadata failure classification", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("logs a bounded operational category and retains validated stale inventory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const discover = vi.fn().mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error("private upstream credential detail"));
    const source = createClaudeModelCatalogSource({ discover });
    const first = await source(provider, principal);
    source.invalidate(principal);
    await expect(source(provider, principal)).resolves.toBe(first);
    expect(warn).toHaveBeenCalledWith("[chat-providers] Claude model discovery unavailable", { category: "discovery_failed" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private upstream");
  });

  it.each([
    ["schema", () => Promise.resolve([{ displayName: "missing model ID" }])],
    ["wire JSON", () => Promise.reject(new SyntaxError("private invalid wire bytes"))],
  ] as const)("classifies invalid %s metadata without leaking it", async (_kind, discover) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = createClaudeModelCatalogSource({ discover });
    await expect(source(provider, principal)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("[chat-providers] Claude model discovery unavailable", { category: "invalid_metadata" });
  });

  it("classifies its bounded deadline separately from upstream failure", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = createClaudeModelCatalogSource({ timeoutMs: 10, discover: () => new Promise(() => {}) });
    const result = source(provider, principal);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("[chat-providers] Claude model discovery unavailable", { category: "timeout" });
  });

  it.each([
    new TypeError("private programming failure"),
    new ReferenceError("private programming failure"),
    new RangeError("private programming failure"),
    "private non-Error failure",
    { detail: "private non-Error failure" },
  ])("propagates unexpected failures without negatively caching or leaking them %#", async (failure) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const discover = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(inventory);
    const source = createClaudeModelCatalogSource({ discover });
    await expect(source(provider, principal)).rejects.toBe(failure);
    expect(log).toHaveBeenCalledWith("[chat-providers] Unexpected Claude model discovery failure", {
      category: failure instanceof Error ? "programming_error" : "non_error_throw",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect((await source(provider, principal))?.models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
