// @vitest-environment jsdom

import type {
  ProviderUsageResponse,
  ProviderUsageSourceSummary,
  RuntimeSummary,
} from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lowestRemainingWindow,
  selectUsageSource,
  useProviderUsage,
} from "../../desktop/src/renderer/src/stores/provider-usage";

const now = new Date("2026-08-10T12:00:00.000Z");

function source(
  id: string,
  providerId: string,
  remaining: number[],
): ProviderUsageSourceSummary {
  return {
    id,
    displayName: id === "openai-chatgpt" ? "OpenAI / ChatGPT" : "Anthropic",
    linkedAgentProviderIds: [providerId],
    state: "available",
    accuracy: "provider_reported",
    windows: remaining.map((remainingPercent, index) => ({
      id: index === 0 ? "primary" : "secondary",
      label: index === 0 ? "5-hour window" : "7-day window",
      remainingPercent,
    })),
    observedAt: now.toISOString(),
    expiresAt: "2026-08-10T12:05:00.000Z",
    setupActions: [],
  };
}

function usageResponse(
  usageSources: ProviderUsageSourceSummary[] = [
    source("openai-chatgpt", "codex", [72, 41]),
    source("anthropic", "claude", [63]),
  ],
  serverTime = now.toISOString(),
): ProviderUsageResponse {
  return { usageSources, serverTime };
}

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsUsageSummary", enabled: true }],
    providers: [
      {
        id: "claude",
        displayName: "Claude",
        kind: "claude",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
      {
        id: "codex",
        displayName: "Codex",
        kind: "codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: {
      items: [
        {
          id: "thread_claude",
          providerId: "claude",
          title: "Claude task",
          status: "running",
          attention: "none",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 24_000,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8_192,
      maxListItems: 20,
    },
    serverTime: now.toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("provider usage selection", () => {
  it("prefers the active coding thread provider over the configured default", () => {
    expect(selectUsageSource(usageResponse(), summary(), "thread_claude", "codex")?.id)
      .toBe("anthropic");
  });

  it("uses the configured default without an active coding thread", () => {
    expect(selectUsageSource(usageResponse(), summary(), null, "codex")?.id)
      .toBe("openai-chatgpt");
  });

  it("uses the first ready provider in automatic mode", () => {
    expect(selectUsageSource(usageResponse(), summary(), null, null)?.id)
      .toBe("anthropic");
  });

  it("does not borrow percentages for missing or ambiguous provider links", () => {
    const ambiguous = usageResponse([
      source("openai-chatgpt", "codex", [72]),
      source("openai-api", "codex", [90]),
      source("anthropic", "claude", [63]),
    ]);

    expect(selectUsageSource(ambiguous, summary(), null, "codex")).toBeNull();
    expect(selectUsageSource(usageResponse(), summary(), null, "pi")).toBeNull();
  });

  it("selects the literal lowest remaining window", () => {
    expect(lowestRemainingWindow(source("openai-chatgpt", "codex", [72, 41])))
      .toMatchObject({ id: "secondary", remainingPercent: 41 });
  });
});

describe("provider usage store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    window.operator = {
      invoke: vi.fn(async () => usageResponse()),
      on: vi.fn(() => () => undefined),
    };
    useProviderUsage.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears previous scope data and discards an obsolete in-flight result", async () => {
    const previous = deferred<ProviderUsageResponse>();
    const current = deferred<ProviderUsageResponse>();
    vi.mocked(window.operator.invoke)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    useProviderUsage.getState().ensureRuntimeScope("owner-a|primary|1");
    const previousRefresh = useProviderUsage.getState().refresh();

    useProviderUsage.getState().ensureRuntimeScope("owner-b|secondary|2");
    expect(useProviderUsage.getState().response).toBeNull();
    const currentRefresh = useProviderUsage.getState().refresh();
    current.resolve(usageResponse([source("anthropic", "claude", [63])]));
    await currentRefresh;
    previous.resolve(usageResponse([source("openai-chatgpt", "codex", [72])]));
    await previousRefresh;

    expect(useProviderUsage.getState()).toMatchObject({
      runtimeScope: "owner-b|secondary|2",
      status: "ready",
    });
    expect(useProviderUsage.getState().response?.usageSources[0]?.id).toBe("anthropic");
  });

  it("coalesces concurrent refreshes for the same runtime scope", async () => {
    const pending = deferred<ProviderUsageResponse>();
    vi.mocked(window.operator.invoke).mockReturnValue(pending.promise);
    useProviderUsage.getState().ensureRuntimeScope("owner-a|primary|1");

    const first = useProviderUsage.getState().refresh();
    const second = useProviderUsage.getState().refresh();
    expect(window.operator.invoke).toHaveBeenCalledOnce();
    pending.resolve(usageResponse());
    await Promise.all([first, second]);

    expect(useProviderUsage.getState().status).toBe("ready");
  });

  it("keeps last-good data and uses allowlisted copy when refresh fails", async () => {
    useProviderUsage.getState().ensureRuntimeScope("owner-a|primary|1");
    await useProviderUsage.getState().refresh();
    const lastGood = useProviderUsage.getState().response;
    vi.mocked(window.operator.invoke).mockRejectedValueOnce(
      new Error("provider token failed at /home/private"),
    );

    await useProviderUsage.getState().refresh({ force: true });

    expect(useProviderUsage.getState()).toMatchObject({
      status: "error",
      response: lastGood,
      error: "Provider usage is temporarily unavailable.",
    });
  });

  it("refreshes stale data while preserving fresh data unless forced", async () => {
    vi.mocked(window.operator.invoke).mockImplementation(async () =>
      usageResponse(undefined, new Date().toISOString())
    );
    useProviderUsage.getState().ensureRuntimeScope("owner-a|primary|1");

    await useProviderUsage.getState().refresh();
    await useProviderUsage.getState().refresh();
    expect(window.operator.invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await useProviderUsage.getState().refresh();
    expect(window.operator.invoke).toHaveBeenCalledTimes(2);

    await useProviderUsage.getState().refresh({ force: true });
    expect(window.operator.invoke).toHaveBeenCalledTimes(3);
    expect(window.operator.invoke).toHaveBeenLastCalledWith(
      "runtime:get-provider-usage",
      { forceRefresh: true },
    );
  });
});
