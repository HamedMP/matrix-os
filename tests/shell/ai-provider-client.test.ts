import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderClientError,
  deriveReadyModelChoices,
  loadAiProviderSnapshot,
  normalizeAiProviderSnapshot,
  safeAiProviderError,
} from "../../shell/src/lib/ai-providers.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

afterEach(() => vi.restoreAllMocks());

describe("shell AI provider client", () => {
  it("normalizes the bounded snapshot and derives only runnable model choices", () => {
    const snapshot = normalizeAiProviderSnapshot(makeAiProviderSnapshot());

    expect(deriveReadyModelChoices(snapshot)).toEqual([{
      instanceId: "kernel_matrix_included",
      accessSourceId: "matrix_included",
      accessSourceLabel: "Matrix AI",
      fundingLabel: "Included",
      modelId: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      effortControls: ["low", "medium", "high", "max"],
    }]);
  });

  it("excludes unavailable instances even when their model ids remain cataloged", () => {
    const fixture = makeAiProviderSnapshot();
    fixture.instances[0] = {
      ...fixture.instances[0],
      readiness: { ...fixture.instances[0].readiness, state: "stale", action: "retry" },
      defaultModelId: null,
    };
    fixture.active = { providerInstanceId: null, accessSourceId: null, modelId: null };

    expect(deriveReadyModelChoices(normalizeAiProviderSnapshot(fixture))).toEqual([]);
  });

  it("uses an abortable refresh request and rejects oversized responses", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn(async () => Response.json(makeAiProviderSnapshot()));

    await expect(loadAiProviderSnapshot({ fetcher, refresh: true })).resolves
      .toMatchObject({ contractVersion: 3 });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/ai/providers?refresh=true"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(timeout).toHaveBeenCalledWith(10_000);

    const oversized = vi.fn(async () => new Response("x".repeat(1_048_577)));
    await expect(loadAiProviderSnapshot({ fetcher: oversized })).rejects
      .toBeInstanceOf(AiProviderClientError);
  });

  it("allowlists client errors without reflecting provider or path details", () => {
    expect(safeAiProviderError("provider_status_unavailable"))
      .toBe("AI provider status is temporarily unavailable.");
    expect(safeAiProviderError("Anthropic sk-secret /opt/matrix/private"))
      .toBe("AI provider status is unavailable.");
  });

  it("keeps the decisive provider fixture free of secrets, raw errors, and paths", () => {
    const serialized = JSON.stringify(normalizeAiProviderSnapshot(makeAiProviderSnapshot()));

    expect(serialized).not.toMatch(/sk-[a-z0-9_-]+/i);
    expect(serialized).not.toContain("/opt/");
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toMatch(/(?:error|exception|stack|stderr|stdout)/i);
  });
});
