# Matrix app capabilities and Linux host workflows

Read this before deciding an installation, sync, schedule, notification or integration is unavailable. Discover the installed release, MATRIX_HOME, current tool schemas and allowed scope. Matrix is a Linux computer with an app platform; a project's restricted coding-agent run and an app WebView have different authority from the owner host. A skill is guidance, not a permission grant. Source descriptions below require checking the installed release before use.

## Choose the right layer

| Need | Existing route | What to verify |
| --- | --- | --- |
| App UI | Vite + React + TypeScript, matrix.json, dist; gateway serves /apps/<slug>/ | Manifest, listing policy, assets and launch on each required surface |
| Structured records | Injected MatrixOS.db; owner Postgres | Declared tables, confirmed writes, reopen and owner/app scope |
| AI in an app | MatrixOS.ai.generate(input) | Installed bridge schema, response, funding/readiness and failure states |
| Ask the owner agent to act | MatrixOS.generate(context) | This is a request to the agent, not a returned execution receipt |
| Connected services | MatrixOS.integrations() inventory; production execution through the authorized owner agent | Exact owner account/action; MatrixOS.service exists but its execution route is currently non-production only |
| Allowed keyless public data | MatrixOS.proxyFetch(url) | Current allowlist; it is not an unrestricted internet proxy |
| Navigation | MatrixOS.openApp(name, path), MatrixOS.navigate(route, context) | Supported host action and known installed app/route |
| Build/install/publish | Owner app directory; registered app lifecycle tools where available | Source path, slug, trust provenance and actual tool authorization |
| Recurring reminder | manage_cron or authenticated gateway cron administration | Target delivery and active job registration; reminders, not script execution |
| Periodic agent work | Gateway heartbeat with agents/heartbeat.md | Runtime enabled, funding, interval/active hours and observed execution |
| Durable script or importer | Owner Linux service/timer | Authorized host operation, named timezone, worker status and logs |
| Notifications | Existing host UI/agent attention, configured channel adapters and mobile push | Delivery category, owner binding, permission and actual surface; see below |

Skills also cover design, integration discovery, debugging and host development. Linux can run available command-line tools, git, package/build commands, media processing and bounded background programs within authorized paths. Files, export artifacts, identity and configuration remain inspectable files; app records remain owner-controlled Postgres. Put secrets in the existing host credential path, never in app source, dist, browser storage or screenshots. Do not introduce root package installs or a new database simply because a builder can invoke Bash.

## Finish an app installation

1. Resolve MATRIX_HOME and the permitted source/output directories. Build in the owner app directory when this run can write there; otherwise finish the project artifact in its authorized workspace.
2. Complete the build, manifest, assets, worker, and verification report before asking the user to do installation work. Run the skill's app verifier and retain any failed/pending launch checks.
3. Apps with valid manifests are discovered by the catalog. Kernel IPC registers install_app with source_path and slug, and fork_app/publish_app for their separate purposes. Use them **only when registered and authorized** in this run. A generic integrations MCP connection is not proof that app lifecycle tools exist. Installing copies source; it does not prove its worker started, icon exists, data imported, permissions granted or launch works.
4. Confirm the catalog entry, icon, authenticated launch, bridge, data round trip and any importer status. Preserve an existing installation and owner records; never overwrite it silently or relabel a store app as first-party.
5. A project sandbox may permit writes only to its worktree/scratch. A read-only apps directory is a run-scope restriction, not proof that Matrix cannot install apps. Use an existing authorized owner lifecycle/host operation if it genuinely grants the required authority. Do not use another API, token, or shell route to bypass a denial. If the authorized capability is absent, record the concrete missing operation and prepared artifact for a host capability repair or narrowly scoped permission decision. Do not default to telling the user to run an unverified install script or grant full access.

The platform owns authentication. Native Mobile obtains an app session through POST /api/apps/<slug>/session-token and loads the returned /apps/<slug>/ launch URL. Session creation is not a frontend installation API. Diagnose authentication, listing policy and app-discovery failures separately; never copy shell credentials into an iframe or turn off authentication to make a preview load.

## Connected-account sync and AI

Use the installed matrix-integrations skill: list accounts, describe the exact action, then call its actual schema. The injected MatrixOS.integrations() can list connected accounts, but **direct app service execution is blocked in production** by the current gateway route. MatrixOS.service owns transport only when that installed route permits it; a present JavaScript method is not proof of executable access. Production app sync must use an existing authorized kernel-mediated workflow via MatrixOS.generate and read its persisted progress/results. Never remove the production gate or expose integration credentials to make the app work. If no authorized workflow exists, implement the required host dependency and keep the app's status truthful.

Never choose the first Gmail connection when the user has several accounts. Select its exact account_label for a supported bridge call, or pass the selected connection identifier through the actual agent-tool schema. Store the source account ID and explicit work/personal classification with imported records so filters remain meaningful. Mark an account ending in a requested work domain as work only using the user's stated rule, and allow correction.

An importer should checkpoint progress in owner Postgres, use stable external IDs for idempotent inserts, transact related writes and bound each batch. Keep source evidence and extraction confidence; show review-needed records instead of inventing amounts, currencies, destinations or dates. Use timeouts, bounded retries and resumable status. A Sync now action needs a confirmed worker result/status, not a spinning button that claims success on enqueue. MatrixOS.generate can request an existing authorized agent workflow, but it is fire-and-forget; read actual persisted progress before claiming completion. MatrixOS.ai.generate is the separate request/response app-AI operation; validate its current payload and result rather than guessing.

## Three kinds of scheduling

**Cron reminders:** manage_cron uses its registered add/list/remove schema; schedule is a JSON-encoded string in the current IPC tool, e.g. {"type":"cron","cron":"0 9 * * *"}. The gateway cron administration takes a schedule object. Current triggers send the configured message to a configured channel/chat; they do not execute an arbitrary command or dispatch the agent. Cron uses the host timezone; its current schedule type has no per-job timezone. Confirm the live job and target rather than treating a config-file write or tool acknowledgement as evidence of execution.

**Heartbeat:** the running gateway periodically dispatches an agent prompt from agents/heartbeat.md. Use it for available authorized periodic checks; verify activation, cadence, active hours and funding. Do not promise an exact 03:00 run from a periodic heartbeat or confuse a saved task with an executable scheduled job.

**Linux services/timers:** for a deterministic importer or an exact local-time script, use an authorized owner host service/timer. This runs independently of the app window. The app runtime's node process manager has idle shutdown and restart limits; it is not a permanent worker. A browser interval also stops when the view/process is suspended.

For an owner-approved worker, prepare a one-shot service and timer under that Linux user's actual configuration directory. Resolve the effective home, executable and project paths first; placeholders below must be replaced with validated absolute paths. Use a safe app slug for the unit name. No shell credentials or script paths come from untrusted app input.

```ini
# <slug>-sync.service
[Unit]
Description=App synchronization

[Service]
Type=oneshot
WorkingDirectory=<absolute-owner-project-directory>
ExecStart=<absolute-runtime-executable> <absolute-worker-script>
TimeoutStartSec=120

# <slug>-sync.timer
[Unit]
Description=Daily app synchronization

[Timer]
OnCalendar=*-*-* 03:00:00 Europe/London
Persistent=true
Unit=<slug>-sync.service

[Install]
WantedBy=timers.target
```

Validate with systemd-analyze calendar '*-*-* 03:00:00 Europe/London', then use the authorized owner host operation to reload units, enable/start this timer and inspect its next trigger. This calendar expression was checked against Linux systemd; named timezones handle seasonal offsets. Persistent=true catches a missed calendar run on activation, not every missed interval. See the [systemd time manual](https://www.man7.org/linux/man-pages/man7/systemd.time.7.html).

The owner user manager requires its real UID and available bus, commonly /run/user/<uid>/bus; never assume UID 1000. A missing bus and a policy-denied bus are different failures. Correct a genuinely missing environment only within an authorized host operation; do not widen a project sandbox or re-route a denied systemctl call. Verify systemctl --user status/list-timers and bounded private journal output, plus a manual one-shot and persisted last success. Apply the same concurrency guard to scheduled and Sync now runs. Preserve existing jobs and Matrix's core gateway/shell/sync/update services. Keep temporary artifacts bounded and remove unused app units when uninstalling through the supported lifecycle.

## Notifications on Matrix surfaces

There is currently **no general app notification bridge** in the checked Web/Electron MatrixOS API. Do not invent MatrixOS.notify(), MatrixOS.schedule() or an app notification-send endpoint. A browser Notification permission request is not a Matrix notification integration.

| Surface/path | Existing behavior | Builder responsibility |
| --- | --- | --- |
| App foreground | App-local feedback after an action | Accessible status/error UI; show success only after confirmation |
| Web Canvas / Web Desktop / Electron Desktop | Host notification/agent-attention UI for supported events | Use an existing registered host event path; an app-local toast does not become a system-wide notification |
| Native Mobile | Expo push adapter and native permission/registration for supported message/task/cron/security/agent categories | Inspect actual event wiring/preferences; registration is not app sending and OS permission may be denied |
| Messaging channels | Configured adapters and reminder targets | Discover the connected destination and obtain user authorization for outbound communication |

POST /api/push/register is **registration, not sending**. A trusted host sender must derive ownerId from authenticated owner context; a client-supplied owner ID is not authority. Push adapter acceptance is **not device delivery confirmation**. Current mobile notification routing does not establish an arbitrary app deep link; test taps against the installed route instead of promising that the app opens. Respect preferences, deduplication/rate limits and private lock-screen content. Never reuse agent attention to fabricate an app event.

When the requested product needs new app notifications, finish its event model and UI while implementing or handing off the host dependency explicitly: a typed owner/app-scoped operation, permission decision, bounded payload/rate/deduplication, desktop event presentation, existing owner-bound mobile push adapter and validated app routing. Verify foreground/background/tap, denied permission, sign-out/account switch and retry behavior on actual devices. Mark this as runtime work required, not a present capability. Do not hide the gap behind a fake successful notification button.

## Mobile loading and caching

Read the installed app-builder's references/expo-loading-and-cache.md alongside its responsive reference. Validate the installed host bridge separately from responsive CSS. Preserve owner data and confirm save/reopen on Web Mobile and actual Native Mobile. Product UI should provide a truthful retryable state; developer reports identify the missing host dependency precisely.

## Completion evidence

In BUILD-REPORT.md record the installed host version, tools actually available, source/build paths, supported surfaces, launch/persistence results, importer status, schedule target/observed trigger, notification category/delivery evidence and pending dependencies. Never report skill prose, an installed file, a queued request or a screenshot as proof of completed work.
