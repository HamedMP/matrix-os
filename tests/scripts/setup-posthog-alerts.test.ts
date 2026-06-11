import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_NAME,
  INSIGHT_DEFINITIONS,
  buildTrendsInsightPayload,
  ensureDashboard,
  ensureInsight,
  readConfig,
  runSetup,
  usage,
} from "../../scripts/observability/setup-posthog-alerts.mjs";

const CONFIG = {
  apiKey: "phx_test_key",
  projectId: "123",
  apiHost: "https://eu.posthog.com",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readConfig", () => {
  it("requires the personal API key and project id", () => {
    expect(readConfig({})).toBeNull();
    expect(readConfig({ POSTHOG_PERSONAL_API_KEY: "phx" })).toBeNull();
    expect(readConfig({ POSTHOG_PROJECT_ID: "123" })).toBeNull();
  });

  it("defaults the API host to PostHog EU and trims trailing slashes", () => {
    const config = readConfig({
      POSTHOG_PERSONAL_API_KEY: "phx",
      POSTHOG_PROJECT_ID: "123",
    });
    expect(config).toEqual({ apiKey: "phx", projectId: "123", apiHost: "https://eu.posthog.com" });

    const custom = readConfig({
      POSTHOG_PERSONAL_API_KEY: "phx",
      POSTHOG_PROJECT_ID: "123",
      POSTHOG_API_HOST: "https://us.posthog.com/",
    });
    expect(custom?.apiHost).toBe("https://us.posthog.com");
  });

  it("documents required env vars in the usage message without leaking values", () => {
    expect(usage()).toContain("POSTHOG_PERSONAL_API_KEY");
    expect(usage()).toContain("POSTHOG_PROJECT_ID");
  });
});

describe("insight definitions", () => {
  it("covers the exception and funnel failure surfaces", () => {
    const names = INSIGHT_DEFINITIONS.map((def) => def.name);
    expect(names).toContain("$exception count by service");
    expect(names).toContain("$exception count by source");
    expect(names).toContain("VPS provision failures");
    expect(names).toContain("Billing webhook failures");
    expect(names).toContain("Onboarding failures");
  });

  it("filters onboarding failures to the gateway_product onboarding_failed sub-event", () => {
    const onboarding = INSIGHT_DEFINITIONS.find((def) => def.name === "Onboarding failures");
    expect(onboarding?.event).toBe("gateway_product");
    expect(onboarding?.propertyFilters).toEqual([
      { key: "event", value: "onboarding_failed", operator: "exact", type: "event" },
    ]);
  });

  it("builds a minimal TrendsQuery insight payload attached to the dashboard", () => {
    const payload = buildTrendsInsightPayload(
      {
        name: "$exception count by service",
        event: "$exception",
        breakdownProperty: "service",
      },
      42,
    );

    expect(payload.name).toBe("$exception count by service");
    expect(payload.dashboards).toEqual([42]);
    expect(payload.query).toEqual({
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        interval: "day",
        series: [{ kind: "EventsNode", event: "$exception", math: "total" }],
        breakdownFilter: { breakdown: "service", breakdown_type: "event" },
      },
    });
  });

  it("includes property filters on the series when provided", () => {
    const payload = buildTrendsInsightPayload(
      {
        name: "Onboarding failures",
        event: "gateway_product",
        breakdownProperty: "stage",
        propertyFilters: [
          { key: "event", value: "onboarding_failed", operator: "exact", type: "event" },
        ],
      },
      7,
    );

    expect(payload.query.source.series[0]).toEqual({
      kind: "EventsNode",
      event: "gateway_product",
      math: "total",
      properties: [{ key: "event", value: "onboarding_failed", operator: "exact", type: "event" }],
    });
  });
});

describe("idempotent provisioning", () => {
  it("reuses an existing dashboard with the same name instead of creating a duplicate", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [{ id: 9, name: DASHBOARD_NAME }] }),
    );

    const result = await ensureDashboard(CONFIG, { fetch: fetchMock });

    expect(result).toEqual({ id: 9, created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/projects/123/dashboards/");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phx_test_key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates the dashboard when no name match exists", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({ results: [{ id: 1, name: "Other dashboard" }] });
      }
      return jsonResponse({ id: 55, name: DASHBOARD_NAME }, 201);
    });

    const result = await ensureDashboard(CONFIG, { fetch: fetchMock });

    expect(result).toEqual({ id: 55, created: true });
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall?.[1] as RequestInit).body as string);
    expect(body.name).toBe(DASHBOARD_NAME);
  });

  it("skips insight creation when an insight with the same name exists", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [{ id: 3, name: "$exception count by service" }] }),
    );

    const result = await ensureInsight(
      CONFIG,
      { name: "$exception count by service", event: "$exception", breakdownProperty: "service" },
      42,
      { fetch: fetchMock },
    );

    expect(result).toEqual({ name: "$exception count by service", created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates missing insights attached to the dashboard", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({ id: 4, name: "VPS provision failures" }, 201);
    });

    const result = await ensureInsight(
      CONFIG,
      {
        name: "VPS provision failures",
        event: "matrix_vps_provision_failed",
        breakdownProperty: "failure_code",
      },
      42,
      { fetch: fetchMock },
    );

    expect(result).toEqual({ name: "VPS provision failures", created: true });
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((createCall?.[1] as RequestInit).body as string);
    expect(body.dashboards).toEqual([42]);
    expect(body.query.source.kind).toBe("TrendsQuery");
  });

  it("throws a status-only error on API failures without echoing the key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: "nope" }, 403));

    await expect(ensureDashboard(CONFIG, { fetch: fetchMock })).rejects.toThrow(/403/);
    await expect(ensureDashboard(CONFIG, { fetch: fetchMock })).rejects.not.toThrow(
      /phx_test_key/,
    );
  });

  it("provisions the dashboard and every insight exactly once end to end", async () => {
    const created: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({ results: [] });
      }
      const body = JSON.parse(init?.body as string);
      created.push(body.name);
      return jsonResponse({ id: created.length, name: body.name }, 201);
    });

    const summary = await runSetup(CONFIG, { fetch: fetchMock, log: () => {} });

    expect(summary.dashboard).toEqual({ id: 1, created: true });
    expect(summary.insights).toHaveLength(INSIGHT_DEFINITIONS.length);
    expect(summary.insights.every((insight) => insight.created)).toBe(true);
    expect(created).toContain("Matrix OS Errors");
  });
});
