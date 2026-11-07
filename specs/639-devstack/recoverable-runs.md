# Recoverable DevStack runs

ENG-432 extends the existing DevStack CLI and Preview skill with an operator run that outlives the CLI connection. An agent chooses an explicit registered runtime and worktree before dispatch. The same agent can reconnect with the same run ID and recover the exit code, test outcome, incremental logs and authenticated preview URL.

## Authority

| Entry point | Required authority | Public |
| --- | --- | --- |
| `POST /api/devstack/runs` | Verified Clerk session bearer, current membership in the configured Private Preview Clerk organization, configured pilot Clerk user ID, and an agent-generated recovery key | No |
| `GET /api/devstack/runs/:runId?cursor=N` | Fresh verification of the same Clerk membership and subject, plus the original run recovery key | No |
| Returned `/vm/<handle>/` link | Existing Platform owner authentication and registered runtime routing | No |
| Sign-in continuation for a registered preview | Public Clerk sign-in. The return target is restricted to a canonical same-origin registered preview root. | Yes |

The isolated Platform enables the run routes only in registered-runtime mode. The operator uses the same `MATRIX_INTERNAL_CLERK_ORG_ID` as Private Preview and configures at most three explicit Clerk user IDs. DevStack checks current membership with the existing Clerk Backend API reader and requires the caller to be on that list. Pending and impersonated sessions are rejected. A missing membership denies access, and an unavailable Clerk lookup fails closed. The preview link carries no session token or run key and requires the normal signed-in owner session.

Set the existing Clerk backend credential through the protected Platform environment. Private Preview uses the collaboration projection and registered-runtime mode leaves collaboration disabled. DevStack checks the same membership directly with a bounded read-only request for the authenticated subject. Existing members need no new Clerk claim or role.

Set `MATRIX_DEVSTACK_RUN_CONFIG` to JSON with `issuer`, `previewOrigin`, `operators` and `targets`. Each target specifies `runtime`, `worktree`, `owner`, `handle`, `containerId`, `cwd` and `revision`. The two origins are HTTPS. `cwd` is relative to the registered instance HOME and starts under `projects/`. Prepare the isolated checkout before enabling a target. The pilot uses one operator as the runtime owner and can bind multiple worktrees to that runtime.

## Binding and recovery

- A trusted configuration maps the requested runtime and worktree IDs to an owner, registered handle, full container ID, private working directory and expected Git revision. A launch rechecks the owner-bound registry, exact CID, and worktree identity before running the command through the existing bounded Gateway runner. Gateway uses its command environment and cwd rules. The DevStack wrapper owns the command's process group and cleans up that group after timeout or leader exit. Commands that deliberately escape into a new OS session are outside this guarantee. The authenticated request cannot choose the URL, container, host path or preview host. The checkout placement and private runtime alias remain operator responsibilities.
- The CLI chooses the UUID and recovery key before network I/O, writes them to its private state, and uses the same pair when retrying an ambiguous response. The server stores a digest of the recovery key. A run ID with different inputs cannot start a second execution. Keep the selected runtime, worktree and revision with the result.
- Keep one active run per bound target. Persist admission before dispatch and persist the terminal outcome in the isolated Platform database. A client disconnect does not stop a submitted command. An uncertain dispatch stays fenced until the lease expires. A lost executor is reported as interrupted after the lease. The service never automatically replays a command with an uncertain outcome.
- The finite runner returns stdout and stderr at completion. The result API pages bounded retained log records using a cursor and reports truncation. Test invocations report the actual exit status, including timeout, rather than parsing arbitrary runner output as structured test counts. Retain runs for 24 hours, with a cap of 256 records and a 120-second command deadline. Bound output and response size. Use no-store responses and never include recovery keys, bearer tokens or upstream errors in results.

## Preview sign-in continuation

An unauthenticated browser opening the generated preview URL receives a private, non-cacheable redirect to Platform sign-in. The return path contains only the original same-origin preview root. The sign-in view uses the publishable key from the same Clerk instance as the configured session verifier and gives that path to Clerk. The existing registered runtime router checks the owner again after login. Conflicting browser sessions fail closed with a recovery message instead of redirecting repeatedly. This flow never provisions a computer or invokes ordinary billing or runtime selection. API and WebSocket authentication keep their existing behavior.

## Acceptance

Test the normal CLI against real isolated Linux Platform, PostgreSQL and Gateway. Dispatch in one Git worktree, exit the submitting process before the command finishes, and read back with the same run ID from a new process. Assert exit code, test outcome, cursor continuity and owner-bound preview URL. Verify a second worktree resolves its own cwd and revision. Reject an unauthorized account, a whitelisted account without current membership, a different authorized user or missing recovery key, a mismatched runtime/worktree, and a changed worktree binding. A retry with the original identity must produce only one execution. Open the exact issued preview link without cookies, follow the Clerk sign-in redirect, and verify that an owner session returns to the same link. Verify another signed-in account cannot open the owner’s preview. Stop the test services with evidence retained and compare installed service snapshots.

The Stage 2 permission fixture uses a separate signing key and an isolated Clerk JWKS and membership response fixture. Before rollout, verify the three pilot accounts’ Clerk IDs and current membership in the configured Private Preview organization. Public documentation uses example IDs only.
