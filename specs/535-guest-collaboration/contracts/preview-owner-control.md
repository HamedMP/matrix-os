# Disposable preview owner control

A collaboration preview has a separate platform authority. Its owner computer
retains the original gateway credential so the original controller can deploy
or restore it. An explicitly connected preview also accepts its preview
controller credential, with a signed principal restricted to the configured
computer owner.

## Authentication matrix

| Transport | Original controller | Preview controller | Other actors |
| --- | --- | --- | --- |
| Protected HTTP routes | Existing gateway bearer policy | Preview bearer plus signed exact owner proof | Preview credential rejected |
| Platform-terminated WebSocket upgrade | Existing gateway policy | Same bearer and signed exact owner headers | Preview credential rejected |
| Direct query-token request | Existing registered WebSocket policy | Query credential alone rejected | Rejected |
| Collaboration routes | Existing route verifier | Existing scoped collaboration verifier | Existing grant policy |

The second controller requires both `MATRIX_PREVIEW_RUNTIME=true` and
`MATRIX_PREVIEW_OWNER_CONTROL=true`, a validated `pr-<number>` handle identical
to the runtime slot, one consistent configured Clerk owner, and a 64-character
hexadecimal preview binding credential. Credentials and owner proofs use
constant-time comparisons. The platform continues to authenticate the caller
and check the machine's access policy before issuing these headers. A valid
preview signature for a member, guest, outsider, or another owner is rejected.

The gateway initializes the authenticated principal before protected handlers
run. It retains existing JWT validation, public/route-scoped verifiers, failed
authentication rate limits and original controller behavior. No user receives
a new machine or organization access grant.

## Binding and rollback

The protected connection workflow verifies the exact handle, runtime slot,
owner and machine. Under its existing exclusive guard lock, it atomically
writes the preview binding plus the two opt-in flags, preserving the original
`MATRIX_AUTH_TOKEN`, file permissions and one pre-connection rollback copy.
The existing guard restores the entire original environment after an
uncommitted connection. Committed connections retain the preview binding
until explicit restoration or disposable computer cleanup. Restoring the
original file removes the second controller without rotating its credential.

## Verification

Regression tests use the real platform credential/proof builders with gateway
authentication and principal resolution. They cover HTTP and WebSocket upgrade
headers, preservation of original control, every opt-in/runtime/owner guard,
forged proof, another runtime credential, and member/guest/outsider denial.
Executed Python binding tests cover atomic install, metadata preservation,
claim ownership and complete restoration.

Live acceptance requires both preview and original-controller owner API
success, a connected owner Web Desktop, denied non-owner computer access, and
the separate sharing journey. Source tests alone do not establish readiness.

## Exact build selection

The connector resolves the open same-repository PR head before choosing a
successful Preview VPS deployment. An exact-head pull-request run remains the
first choice. A trusted `workflow_dispatch` from `main` may also build a PR
head after the gate resolves it; its workflow SHA describes `main` and is not
runtime provenance.

For that fallback, the connector requires a successful completed deployment
from the same repository and unexpired uniquely named runtime and bundle
artifacts for the requested PR. It downloads at most one bundle archive
(2 GiB cap, 180-second deadline), reads only a unique regular `release.json`
(64 KiB cap), and requires its full `gitCommit`, preview kind/channel, PR number
and version suffix to match the requested head. The archive is removed on
success or failure. A stale latest matching deployment fails closed. Existing
route validation, connection-time PR recheck, platform image provenance,
protected environment approval and exact owner/machine checks still apply.


## Manual runtime provenance

A connection selects artifacts for the requested PR, rather than a shared window
of unrelated dispatches. Each candidate must belong to a completed successful
same-repository `main` dispatch of `preview-vps.yml`. The latest qualifying
deployment must prove its full source commit; a stale proof fails closed.

Both built and pinned deployments publish a small installed-provenance artifact
after the existing health and stability checks. A bounded, symlink-safe read of
`/opt/matrix/release.json` and the active app marker must agree on the requested
version, full PR commit, preview kind and `none` channel. No owner data or
credentials are included. The artifact is read without archive extraction.

Older built deployments retain the bounded bundle-metadata fallback. An older
pinned deployment without either provenance or a bundle must be rerun using the
updated trusted workflow; its short version suffix alone cannot prove the full
commit. Artifact search is bounded to five pages of 100 PR-specific candidates,
and downloads retain size/time bounds and explicit cleanup.
