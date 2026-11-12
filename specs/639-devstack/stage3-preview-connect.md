# Open a registered Stage 3 worktree preview

ENG-449 adds the Stage 3 browser entry to the Matrix CLI. The developer's agent edits its assigned worktree from Main Computer. DevStack serves the corresponding isolated checkout for browser validation. Connect only selects an existing registration and opens its preview. The developer's ordinary browser handles Clerk sign-in.

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
