# Recoverable DevStack runs

ENG-432 extends the existing DevStack CLI and Preview skill with an operator run that outlives the CLI connection. An agent chooses an explicit registered runtime and worktree before dispatch. The same agent can reconnect with the same run ID and recover the exit code, test outcome, incremental logs and authenticated preview URL.

## Authority

| Entry point | Required authority | Public |
| --- | --- | --- |
| `POST /api/devstack/runs` | Verified Clerk session bearer, signed `devstack_operator: true` claim, configured pilot Clerk user ID, and an agent-generated recovery key | No |
| `GET /api/devstack/runs/:runId?cursor=N` | Fresh verification of the same Clerk permission and subject, plus the original run recovery key | No |
| Returned `/vm/<handle>/` link | Existing Platform owner authentication and registered runtime routing | No |

The isolated Platform enables the run routes only in registered-runtime mode. The operator provisions the signed claim from Clerk metadata managed by the backend and configures at most three explicit, immutable Clerk user IDs. Pilot configuration admits the three approved accounts. No email, organization membership alone, agent prompt, caller header or Matrix sync token grants operator access. The permission has the lifetime of the verified Clerk session token. The preview link carries no session token or run key and requires the normal signed-in owner session.

The operator sets the claim in the intended Clerk instance's session token customization. Grant the boolean through backend-managed user metadata on the approved accounts and use that field as the signed claim. Use the verified Clerk subject IDs in the Platform allowlist. The pilot must never use a user-editable metadata field. Deploy the public verification key or existing backend verifier configuration through the normal protected Platform environment.

Set `MATRIX_DEVSTACK_RUN_CONFIG` to JSON with `issuer`, `previewOrigin`, `operators` and `targets`. Each target specifies `runtime`, `worktree`, `owner`, `handle`, `containerId`, `cwd` and `revision`. The two origins are HTTPS. `cwd` is relative to the registered instance HOME and starts under `projects/`. Prepare the isolated checkout before enabling a target. The pilot uses one operator as the runtime owner and can bind multiple worktrees to that runtime.

## Binding and recovery

- A trusted configuration maps the requested runtime and worktree IDs to an owner, registered handle, full container ID, private working directory and expected Git revision. A launch rechecks the owner-bound registry, exact CID, and worktree identity before running the command through the existing bounded Gateway runner. Gateway uses its command environment and cwd rules. The DevStack wrapper owns the command's process group and cleans up that group after timeout or leader exit. Commands that deliberately escape into a new OS session are outside this guarantee. The authenticated request cannot choose the URL, container, host path or preview host. The checkout placement and private runtime alias remain operator responsibilities.
- The CLI chooses the UUID and recovery key before network I/O, writes them to its private state, and uses the same pair when retrying an ambiguous response. The server stores a digest of the recovery key. A run ID with different inputs cannot start a second execution. Keep the selected runtime, worktree and revision with the result.
- Keep one active run per bound target. Persist admission before dispatch and persist the terminal outcome in the isolated Platform database. A client disconnect does not stop a submitted command. An uncertain dispatch stays fenced until the lease expires. A lost executor is reported as interrupted after the lease. The service never automatically replays a command with an uncertain outcome.
- The finite runner returns stdout and stderr at completion. The result API pages bounded retained log records using a cursor and reports truncation. Test invocations report the actual exit status, including timeout, rather than parsing arbitrary runner output as structured test counts. Retain runs for 24 hours, with a cap of 256 records and a 120-second command deadline. Bound output and response size. Use no-store responses and never include recovery keys, bearer tokens or upstream errors in results.

## Acceptance

Test the normal CLI against real isolated Linux Platform, PostgreSQL and Gateway. Dispatch in one Git worktree, exit the submitting process before the command finishes, and read back with the same run ID from a new process. Assert exit code, test outcome, cursor continuity and owner-bound preview URL. Verify a second worktree resolves its own cwd and revision. Reject an unauthorized account, an allowed subject without the signed claim, a different authorized user or missing recovery key, a mismatched runtime/worktree, and a changed worktree binding. A retry with the original identity must produce only one execution. Stop the test services with evidence retained and compare installed service snapshots.

The Stage 2 permission fixture uses a separate signing key and Clerk-shaped session tokens. The three pilot accounts require verified Clerk IDs and backend-owned grant configuration in the intended Clerk instance before rollout. Public documentation uses example IDs only.
