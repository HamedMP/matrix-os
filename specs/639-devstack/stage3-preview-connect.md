# Open a registered Stage 3 worktree preview

ENG-449 adds the Stage 3 browser entry to the Matrix CLI. The developer's agent edits its assigned worktree from Main Computer. DevStack serves the corresponding isolated checkout for browser validation. Connect only selects an existing registration and opens its preview. The developer's ordinary browser handles Clerk sign-in.

Run `matrix devstack --stage 3 --platform https://devstack.example.test` on a machine that can reach the approved origin. An interactive terminal opens the browser automatically. A non-interactive caller gets the entry URL and can pass `--open` to open it or `--json` to read `entryUrl`. If a DevStack CLI profile already names that origin, run `matrix devstack --stage 3` with the default `devstack` profile or add `--profile <name>`. To select directly, add `--computer <registered-runtime> --worktree <registered-worktree>`. Omit both to pick from the browser. Stage 2 uses the existing local adapter and flags.

The CLI entry URL does not assert readiness. The launcher checks current membership in the Private Preview Clerk organization and limits discovery to the authenticated, configured operator's own registered targets. A selected target must match the current owner, handle, and container ID in the isolated Platform registry. The launcher rechecks that binding on selection and redirects to the canonical `/vm/<handle>/` path. The existing HTTP and WebSocket routers enforce owner access on the preview itself. Current Private Preview membership is checked at the chooser. Direct canonical preview and WebSocket access continue to follow the existing owner-only routing policy. The browser URL carries no credentials. A preview registration maps one worktree to one runtime and one handle.

## Shared Linux rollout

1. Route an approved, normally trusted HTTPS hostname to the isolated Platform using the existing ingress mechanism. Preserve the request host and WebSocket upgrades. Configure the same hostname in `MATRIX_APP_ORIGIN` and `MATRIX_APP_DOMAIN_HOSTS`. Configure normal Clerk browser sign-in for that origin. The ingress and trusted certificate are deployment dependencies. Confirm the approved edge policy covers both canonical HTTP and WebSocket access before enabling ingress. If direct access must also require current Private Preview membership, enforce that on both routes before exposing the preview origin.
2. Enable the existing registered-runtime mode and prepare the isolated owner/worktree runtime. Set `MATRIX_DEVSTACK_PREVIEW_CONFIG` on that Platform. It requires the exact Clerk `issuer`, the approved HTTPS `previewOrigin`, up to three Clerk `operators`, and up to 24 `targets`. Each target contains `runtime`, `worktree`, `owner`, `handle`, and `containerId`. Configure `MATRIX_INTERNAL_CLERK_ORG_ID` and the usual Clerk server and publishable keys. The launcher config is independent of operator run execution.
3. Connect the Main Computer agent's selected worktree to its isolated source checkout through the authorized source transport. The transport must keep concurrent edits within that checkout and reject stale or mismatched writes. Existing Stage 2 source commands do not authorize a Stage 3 write. The launcher has no write, sync, restart, or provisioning operation.
4. From a fresh workstation, verify that the CLI opens the preview without a local tunnel, root privileges, hosts changes, custom trust, or a dedicated browser profile. Sign in with the owner, verify the selected worktree, and exercise an agent edit through the source transport and browser hot update. Verify another signed-in account and a stale registration cannot open it. Verify each available runtime through its own route and check that the shared ingress preserves HMR WebSocket upgrades.

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
