#!/usr/bin/env node
// Provisions the PostHog error observability foundation for Matrix OS:
// a "Matrix OS Errors" dashboard plus trends insights for $exception volume
// and the signup/billing/onboarding failure events.
//
// Idempotent: every object is looked up by exact name first (list-then-create)
// so re-running the script never duplicates dashboards or insights.
//
// Note: PostHog error-tracking issue/spike alerts have no stable public API
// and are configured in the PostHog UI. This script covers the dashboard and
// insight foundation those alerts attach to.
//
// Usage:
//   POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 \
//     [POSTHOG_API_HOST=https://eu.posthog.com] \
//     node scripts/observability/setup-posthog-alerts.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";

const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_API_HOST = "https://eu.posthog.com";

export const DASHBOARD_NAME = "Matrix OS Errors";

export const INSIGHT_DEFINITIONS = [
  {
    name: "$exception count by service",
    event: "$exception",
    breakdownProperty: "service",
  },
  {
    name: "$exception count by source",
    event: "$exception",
    breakdownProperty: "source",
  },
  {
    name: "VPS provision failures",
    event: "matrix_vps_provision_failed",
    breakdownProperty: "failure_code",
  },
  {
    name: "Billing webhook failures",
    event: "matrix_billing_webhook_failed",
    breakdownProperty: "reason",
  },
  {
    // The gateway reports onboarding failures as the "gateway_product"
    // envelope event with properties.event = "onboarding_failed".
    name: "Onboarding failures",
    event: "gateway_product",
    breakdownProperty: "stage",
    propertyFilters: [
      { key: "event", value: "onboarding_failed", operator: "exact", type: "event" },
    ],
  },
];

export function usage() {
  return [
    "Usage: POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 \\",
    "  [POSTHOG_API_HOST=https://eu.posthog.com] \\",
    "  node scripts/observability/setup-posthog-alerts.mjs",
    "",
    "Required environment variables:",
    "  POSTHOG_PERSONAL_API_KEY  personal API key with dashboard:write and insight:write scopes",
    "  POSTHOG_PROJECT_ID        numeric PostHog project id",
    "Optional:",
    `  POSTHOG_API_HOST          API host (default ${DEFAULT_API_HOST})`,
  ].join("\n");
}

export function readConfig(env) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const projectId = env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  const apiHost = (env.POSTHOG_API_HOST || DEFAULT_API_HOST).replace(/\/+$/, "");
  return { apiKey, projectId, apiHost };
}

export function buildTrendsInsightPayload(definition, dashboardId) {
  const series = {
    kind: "EventsNode",
    event: definition.event,
    math: "total",
  };
  if (definition.propertyFilters?.length) {
    series.properties = definition.propertyFilters;
  }
  const source = {
    kind: "TrendsQuery",
    interval: "day",
    series: [series],
  };
  if (definition.breakdownProperty) {
    source.breakdownFilter = {
      breakdown: definition.breakdownProperty,
      breakdown_type: "event",
    };
  }
  return {
    name: definition.name,
    saved: true,
    dashboards: [dashboardId],
    query: { kind: "InsightVizNode", source },
  };
}

async function apiRequest(config, requestPath, { method = "GET", body, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${config.apiHost}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Status only: never echo response bodies (or the key) into thrown errors.
    throw new Error(`PostHog API ${method} ${requestPath} failed with status ${response.status}`);
  }
  return response.json();
}

async function findByExactName(config, listPath, name, deps) {
  const search = encodeURIComponent(name);
  // Follow pagination: a truncated first page in a large org would miss the
  // match and create a duplicate instead of reusing the existing object.
  let requestPath = `${listPath}?search=${search}&limit=300`;
  while (requestPath) {
    const page = await apiRequest(config, requestPath, deps);
    const results = Array.isArray(page?.results) ? page.results : [];
    const match = results.find((item) => item?.name === name);
    if (match) return match;
    requestPath = toApiPath(page?.next);
  }
  return null;
}

function toApiPath(next) {
  if (typeof next !== "string" || next.length === 0) return null;
  if (next.startsWith("/")) return next;
  try {
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

export async function ensureDashboard(config, deps = {}) {
  const listPath = `/api/projects/${config.projectId}/dashboards/`;
  const existing = await findByExactName(config, listPath, DASHBOARD_NAME, deps);
  if (existing) {
    return { id: existing.id, created: false };
  }
  const created = await apiRequest(config, listPath, {
    method: "POST",
    body: {
      name: DASHBOARD_NAME,
      description:
        "Matrix OS error observability: exception volume and signup/billing/onboarding failures. Provisioned by scripts/observability/setup-posthog-alerts.mjs.",
      pinned: true,
    },
    ...deps,
  });
  return { id: created.id, created: true };
}

export async function ensureInsight(config, definition, dashboardId, deps = {}) {
  const listPath = `/api/projects/${config.projectId}/insights/`;
  const existing = await findByExactName(config, listPath, definition.name, deps);
  if (existing) {
    return { name: definition.name, created: false };
  }
  await apiRequest(config, listPath, {
    method: "POST",
    body: buildTrendsInsightPayload(definition, dashboardId),
    ...deps,
  });
  return { name: definition.name, created: true };
}

export async function runSetup(config, deps = {}) {
  const log = deps.log ?? console.log;
  const dashboard = await ensureDashboard(config, deps);
  log(
    dashboard.created
      ? `Created dashboard "${DASHBOARD_NAME}" (id ${dashboard.id})`
      : `Dashboard "${DASHBOARD_NAME}" already exists (id ${dashboard.id})`,
  );

  const insights = [];
  for (const definition of INSIGHT_DEFINITIONS) {
    const insight = await ensureInsight(config, definition, dashboard.id, deps);
    insights.push(insight);
    log(
      insight.created
        ? `Created insight "${insight.name}"`
        : `Insight "${insight.name}" already exists`,
    );
  }

  const createdCount = insights.filter((insight) => insight.created).length + (dashboard.created ? 1 : 0);
  const existingCount = insights.length + 1 - createdCount;
  log(`Done: ${createdCount} created, ${existingCount} already existing.`);
  return { dashboard, insights };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  const config = readConfig(process.env);
  if (!config) {
    console.error("Missing POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID.\n");
    console.error(usage());
    process.exit(1);
  }
  runSetup(config).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
