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
