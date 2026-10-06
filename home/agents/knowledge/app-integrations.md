# Owner app integration reads

Production apps use the injected read bridge, available in Web Desktop, Web Canvas,
and Electron Desktop. Never fetch provider APIs or copy connector credentials into
an app. The legacy `MatrixOS.service()` POST remains unavailable in production.

```ts
const { connections } = await MatrixOS.integrationReads();
// [{service, connectionId, label, actions: string[]}]
const account = connections.find(c => c.connectionId === settings.githubConnectionId);
if (!account || !account.actions.includes("list_prs")) {
  throw new Error("Selected GitHub account is unavailable");
}
const { data } = await MatrixOS.serviceRead(
  "github", "list_prs", {repo: settings.repo, page: 1, per_page: 30},
  account.connectionId, account.label,
);
```

Accounts with duplicate labels can be selected by their exact connection ID. The
current owner, service, ID, and label must all match. A removed or renamed account
fails closed. Errors are safe generic messages; preserve the last successful data.

## Explicit owner grants

An app declares each required service in `matrix.json`:

```json
{"permissions": ["integrations:github:read"]}
```

The manifest cannot grant itself access. The owner must separately authorize the
specific app, account IDs, actions, and fixed source selectors in the owner-controlled
`system/app-integrations.json`. Only change the reviewed app's grants; preserve
unrelated grants. Never add grants on behalf of an app-store installer silently.

```json
{
  "grants": [{
    "app": "my-briefing",
    "service": "github",
    "connectionIds": ["selected-owner-connection-id"],
    "actions": ["list_prs", "get_pr", "list_pr_reviews", "list_check_runs"],
    "params": {"repo": "example/project"}
  }]
}
```

Every fixed param must exactly match the request's string, number, or boolean.
Other parameters still pass the registry's strict action schema (for example a PR
number, immutable head SHA, bounded page or cursor). Use separate grants for each
repo/channel/project scope. An empty fixed-param object explicitly grants the
reviewed action's full owner scope; do not use it for scope-specific collection.

The bridge checks the manifest, owner policy, reviewed read risk, account identity,
and parameter scope on each call, including revalidation immediately before
dispatch. No sync, account creation, external writes, or arbitrary URLs are exposed.
Inventory includes only granted active account IDs and registered read actions.

Gateway composition creates one `AppIntegrationReadService` for authenticated app
reads and trusted owner-admitted jobs. `read(request, signal)` revalidates the same
policy; `authorize(request, signal)` rechecks authorization without replaying the
provider read before a job commits. Both share a four-operation concurrency cap. Public inventory and provider reads
share a120-operation/minute budget; bounded internal authorization rechecks do not
consume provider-action admission. These are read capabilities, not a scheduler; closed-UI
execution requires a separately wired durable runner and verified run receipts.

Raw bridge endpoints are authenticated owner routes: GET/POST
`/api/bridge/integrations`. Web's trusted parent and Electron main derive the app
identity; app code does not supply `app`, owner IDs, bearer tokens, or URLs.

## Durable app read jobs

An admitted owner job in `system/app-read-jobs.json` uses the same read grants and
owner-controlled Postgres app schema. The gateway runner collects while the app UI
is closed, prevents overlapping claims, and records bounded run receipts. An app
cannot create a job or widen its integration grants through these controls:

```ts
const { state } = await MatrixOS.readJobStatus("daily-briefing");
await MatrixOS.configureReadJob("daily-briefing", {
  enabled: true, intervalMs: 900000,
  summary: {enabled: true, timezone: "Asia/Shanghai", dailyHour: 9},
});
const { status } = await MatrixOS.runReadJob("daily-briefing");
// accepted means the durable claim succeeded; poll readJobStatus for completion.
await MatrixOS.pauseReadJob("daily-briefing", true);
```

Use `state.configuration` as the actual saved settings. Preserve unknown/unavailable
states rather than implying a schedule was saved. Collection intervals range from
15 minutes to 24 hours. Optional summaries use the existing app AI capability and
require its separate owner policy. Summary settings support `enabled`, an IANA
`timezone`, `dailyHour` (0–23), and `minimumIntervalMs` (30 minutes–24 hours).

`configureReadJob` can also select 1–8 unique `sources` within existing owner grants.
Each source has `id`, `service`, exact `connectionId`, current `label`, and fixed
`params`. Supported selectors are GitHub `{repo}`, Linear `{teamId?, projectId?}`
(at least one), Slack `{channel}` (C/G channel ID), and PostHog
`{region: "eu" | "us", projectId}` (positive integer). Every candidate source is
authorized before saving; selection does not grant new accounts, actions, or scopes.
Display the actual saved sources and fail closed for removed/renamed accounts.

Raw controls are owner-authenticated POST routes under `/api/app-read-jobs/`:
`status`, `run`, `pause`, and `configure`. Web's trusted parent and Electron main
inject the registered app identity. Responses contain safe state/configuration
metadata; app data reads retrieve the app's own persisted results separately.
Generic app data mutations reject the reserved `read_job_state`, `read_job_runs`,
and `read_job_snapshots` tables. Only the trusted runner writes leases, receipts,
and source snapshots; apps may read them and keep local annotations in other tables.
