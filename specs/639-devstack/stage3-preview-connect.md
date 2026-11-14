# Open a registered Stage 3 worktree preview

ENG-449 adds the Stage 3 browser entry to the Matrix CLI. The developer's agent edits its assigned worktree from Main Computer. DevStack serves the corresponding isolated checkout for browser validation. The explicit Stage 3 browser command selects an existing registration and opens its preview. The developer's ordinary browser handles Clerk sign-in.

Run `matrix devstack --stage 3 --platform https://devstack.example.test` on a machine that can reach the approved origin. An interactive terminal opens the browser automatically. A non-interactive caller gets the entry URL and can pass `--open` to open it or `--json` to read `entryUrl`. If a DevStack CLI profile already names that origin, run `matrix devstack --stage 3` with the default `devstack` profile or add `--profile <name>`. Pass `--worktree <worktree-id>` to select the preview at `/devstack/worktrees/<worktree-id>/`. Omit the worktree to pick one in the browser. `--computer` remains accepted with `--worktree` on connect. The worktree ID selects the preview. Stage 2 uses the existing local adapter and flags.

The CLI entry URL carries no credentials. On the dedicated `publicBrowserOnly` Stage 3 origin, Platform serves the Web Desktop at the worktree URL after Clerk sign-in and on refresh. A worktree ID is unique across the public preview registration. Platform resolves the ID to the registered owner, runtime handle, and container, and rechecks the live registration on each protected request and WebSocket upgrade. The URL stays stable when operators update the runtime binding for the same worktree.

### Public preview routes

| Route | Authorization and behavior |
| --- | --- |
| `/devstack` and `/devstack/computers` | Clerk browser session, current Private Preview membership, configured operator. List only the signed-in owner's live worktree bindings. |
| `GET /devstack/worktrees/<worktree-id>/` | The same checks plus exact owner and live runtime binding. Anonymous navigation signs in and returns to the exact worktree path. Authenticated requests serve the existing runtime document through Platform. |
| Worktree-scoped API, asset and WebSocket requests | Apply the same session and registration checks. WebSocket upgrades also require the exact preview origin and an allowed runtime endpoint. Shell derives its Gateway and snapshot scope from the worktree path. |
| `/vm/<handle>/` and existing runtime asset paths | Continue serving registered legacy links through their current authorization. Existing HEL1 Next assets and HMR can use the runtime asset prefix while the document stays at the worktree URL. |

Platform rejects unknown worktrees, stale registrations, owner mismatches, and ambiguous or invalid paths. An expired session requires a new sign-in. The public ingress leaves operator and internal API routes private. On a Stage 3 origin without `publicBrowserOnly`, the worktree URL is a compatibility entry that resolves exactly one owner binding and redirects to the existing `/vm/<handle>/` route. Private Preview and Stage 2 retain their current flow.

When a cold development bundle takes longer than the Clerk browser session to load, a protected late asset may return 401. Reload the worktree URL to resume through Clerk. Verify the rendered desktop, registered Gateway, and HMR connection before reporting readiness.

## Shared Linux rollout

1. Route an approved, normally trusted HTTPS hostname to the isolated Platform using the existing ingress mechanism. Preserve the request host and WebSocket upgrades. Configure that origin in `MATRIX_APP_ORIGIN`, its hostname in `MATRIX_APP_DOMAIN_HOSTS`, and `publicBrowserOnly: true` in `MATRIX_DEVSTACK_PREVIEW_CONFIG`. Configure normal Clerk browser sign-in for that origin. Verify that canonical and legacy HTTP and WebSocket access enforce the public policy before enabling ingress.
2. Enable the existing registered-runtime mode and prepare the isolated owner/worktree runtime. Set `MATRIX_DEVSTACK_PREVIEW_CONFIG` on that Platform. It requires the exact Clerk `issuer`, the approved HTTPS `previewOrigin`, up to three Clerk `operators`, and up to 24 `targets`. Each target contains `runtime`, `worktree`, `owner`, `handle`, and `containerId`. Configure `MATRIX_INTERNAL_CLERK_ORG_ID` and the usual Clerk server and publishable keys. The launcher config is independent of operator run execution.
3. Connect the Main Computer agent's selected worktree to its isolated source checkout through the authorized source transport. The transport must keep concurrent edits within that checkout and reject stale or mismatched writes. Existing Stage 2 source commands do not authorize a Stage 3 write. The launcher has no write, sync, restart, or provisioning operation.
4. From a fresh workstation, verify that the CLI opens the preview without a local tunnel, root privileges, hosts changes, custom trust, or a dedicated browser profile. Verify the owner returns to the same worktree URL after Clerk sign-in, can hard refresh there, and receives a visible source update without document navigation. Verify the worktree-scoped Gateway request and HMR WebSocket reach the same registered runtime. Verify anonymous subrequests, a different owner, and a stale registration are denied. Confirm legacy routes remain available.

Retain the ordinary Private Preview workflow for exact PR bundle validation. Update the separate Matrix OS site guide when this flow is deployed and qualified.

## Stage 3 foreground sync pilot

Run `matrix devstack watch --stage 3 --computer <registered-runtime> --worktree <registered-worktree>` after an operator enrolls that exact binding. The command stays in the foreground. The separate `connect` command still provides the preview link. Watch does not change the active Matrix profile or accept a user-supplied adapter executable.

Install the adapter as an owner-only executable at `~/.matrixos/devstack-stage3-adapter`. The CLI invokes it without a shell as `watch <registered-runtime> <registered-worktree>`. The adapter owns source access, source and runtime generation checks, publishing, test execution, conflict handling, and restoration. The pilot adapter must fence writes to its enrolled source and exact target. An interrupted watcher must restore its verified baseline before releasing the write lease. Provisioning and the hosted connection entry remain separate.

The adapter writes one JSON object per stdout line in this order:

| Event | Fields | Meaning |
| --- | --- | --- |
| `ready` | `type` | The binding and its watcher are ready |
| `update` | `type`, `revision` | The exact source content was applied |
| `test` | `type`, `revision`, `exitCode`, `log` | The matching test run completed |
| `stopped` | `type` | The adapter has finished cleanup |

`revision` is a 64-character lowercase SHA-256 digest, `exitCode` is an integer from 0 through 255, and `log` is a normalized, single-line test summary of up to 4096 characters. A test failure is reported and leaves the watcher available for the next edit. Each update has one matching test event. Interruption may end an update before its test finishes. The CLI rejects unknown fields, malformed or oversized lines, and out-of-order receipts. Adapter stderr stays private.

With `--json`, each receipt uses the standard CLI response envelope and includes the selected Computer and worktree. The command succeeds only after `stopped` and a zero adapter exit. SIGINT and SIGTERM request adapter cleanup and allow up to 45 seconds for it to finish. The CLI also bounds startup to 90 seconds. The adapter remains responsible for recovery if it loses its process before cleanup finishes.

## Hosted CLI pairing and one-shot source sync

The hosted CLI derives a checkout fingerprint from the current Git root and
Git directory identities. It starts approval on the hosted DevStack origin
and prints the fingerprint and browser link. The signed-in developer selects
an enrolled worktree and approves the connection. The terminal receives the
canonical preview URL. An existing Stage 2 adapter retains its default
behavior. Use `matrix devstack --hosted` to explicitly select hosted DevStack.

The source pilot requires an operator-pinned checkout fingerprint and a
single pre-enrolled destination with an isolated receiver. On the Matrix
DevStack origin, a source-enabled connection uploads the current Git delta
after approval. Run `matrix devstack sync --hosted` to explicitly require a
source-enabled destination. A successful upload returns the applied content revision, test exit code and a bounded log
summary for that revision. This is a one-shot command. Each invocation
requires browser approval and sends source only to the Matrix DevStack
origin. It applies staged, unstaged and eligible untracked changes against the exact pinned Git commit. An empty delta
restores that baseline. The pilot supports up to 1,000 regular-file changes
within a 4 MiB JSON request. It rejects changed links, ambiguous paths and
changes that replace a directory with a file or the reverse. Git metadata,
ignored, sensitive and generated files stay out of the delta.

| Route | Authorization and behavior |
| --- | --- |
| `POST /devstack/cli/pair` | Exact hosted origin, rate-limited request, bounded checkout fingerprint. Returns separate one-time approval and poll identifiers. Source-enabled deployments require the configured source fingerprint. |
| `GET /devstack/cli/pair/:approvalId` | For source-enabled deployments, served only on the separate trusted approval origin. An anonymous navigation shows normal Clerk sign-in and returns to the exact approval path. A verified session with matching signed `azp` and live Private Preview membership sees only its enabled live worktrees. |
| `POST /devstack/cli/pair/:approvalId` | Exact approval-origin browser form and signed JWT party, verified Clerk session, current membership and exact owner/worktree/runtime/container. One explicit approval. |
| `POST /devstack/cli/poll` | Separate random poll secret, one exchange. The opaque bearer expires no later than the approving Clerk token and stays in the CLI process. |
| `POST /devstack/cli/source` | Available only with a configured publisher. The dedicated bearer is bound to the approved source and exact target. Check its expiry, current membership and live registration before staging, before publication and before returning results. The request cannot select paths on the server, an owner, a runtime or a test command. |
| `GET /devstack/cli/source/:runId` | When retained runs are enabled, requires a current grant with the original six-field binding and recovery key; checks current membership and registration. Returns only the original retained status/receipt. |

With a Postgres run store, polling advertises `sourceRuns: true`. The CLI saves
its run UUID/key privately before upload and prints the UUID. It sends run headers
with the source POST, receives 202 after durable admission and polls the retained
result. `matrix devstack result --hosted --run-id <uuid>` reads the same run from
another process without uploading source, after current browser approval. The key
stays in a private transport-metadata file; receipts/logs live in Postgres. See
[source run recovery](source-run-recovery.md) for limits, authority and failure
semantics. The synchronous compatibility path still cancels on HTTP disconnect.

Use a persistent, private staging Git checkout and a separate managed
projection. Keep the staging checkout and publication journal inaccessible
to the runtime. Run tests in an isolated unprivileged environment with the
projected source and no Platform or production credentials. A staging
failure before publication leaves the prior serving mirror available. A
pending journal after a partial filesystem mutation requires operator recovery. Preserve the bound
owner, source and target through retries. The checkout fingerprint identifies
the CLI's selected checkout and is a client assertion. It does not attest
which Matrix Computer is running the CLI.

The combined route and Git receiver test uses a fixture Clerk identity and
runs a real test process against two successive revisions. HEL1 deployment
also requires wiring a private publisher and verifying browser HMR with a
real account. Source-enabled startup now requires an approval origin separate
from editable preview code. Pair responses name that HTTPS approval origin;
CLI polling and upload stay on the original hosted origin. Its host serves no
runtime or unrelated Platform routes. The separate verifier requires the signed
JWT's authorized party to match that approval origin.

The opt-in and private socket publisher deployment contract, isolated test
runner, preview container plan, activation/rollback gates and acceptance matrix
are in [spec.md](./spec.md). Run the trusted source service with Node 24:
`node scripts/devstack/stage3-publisher-service.mjs /absolute/private/publisher.json`.
Its 0600 config has `version: 1`, `socketPath`, `stateDir`, the existing full
source/target `enrollment` plus `base` and the Main checkout `sourceIdentity`, and
`test: { image, command, timeoutMs }`. Use a digest-pinned dependency image. Platform
receives only `MATRIX_DEVSTACK_SOURCE_PUBLISHER` JSON containing `socketPath`,
`identity` and `approvalOrigin`; the existing pilot-worktree setting remains
required. Keep all service/config/staging/journal paths outside the uploaded
source mirror. Deployment and access changes require separate owner approval.

Continuous sync and additional developer acceptance are follow-up gates. Publish the corresponding Matrix OS
site guide once the real workflow is released and qualified.
