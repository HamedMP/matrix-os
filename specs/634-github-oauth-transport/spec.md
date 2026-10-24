# Matrix-owned GitHub OAuth transport

Track the outcome under [ENG-376](https://linear.app/matrix-os/issue/ENG-376/replace-pipedream-github-integration-with-matrix-owned-oauth).
The backend slice is [ENG-377](https://linear.app/matrix-os/issue/ENG-377/featintegrations-add-matrix-owned-github-oauth-transport),
Web/Electron is [ENG-378](https://linear.app/matrix-os/issue/ENG-378/featsettings-connect-github-directly-on-web-and-electron),
Native Mobile is [ENG-379](https://linear.app/matrix-os/issue/ENG-379/featmobile-connect-github-through-matrix-oauth),
and public documentation is [ENG-380](https://linear.app/matrix-os/issue/ENG-380/docsintegrations-document-matrix-owned-github-connection).
The product, integration, security, Web/Electron, and Native Mobile owners should
review their respective slices. Each slice remains separately approvable.

## Goal and product decisions

Matrix OS owns the GitHub integration OAuth grant and calls GitHub directly for
the existing eleven reviewed actions. Clerk's GitHub connection remains a Matrix
sign-in method only. Developer authentication inside a Matrix computer remains
the user's separate `gh auth login` and SSH configuration; neither credential is
read, copied, or changed by Connect Apps.

The integration requests `repo` and `notifications` after showing clear consent
copy. GitHub OAuth cannot express read-only private-repository access: `repo` is
broad read/write authority, and the existing `create_issue` action requires that
write authority. `notifications` is required by `get_notifications`. A callback
that grants fewer scopes is rejected, the new token is revoked, and no active
connection is created. The implementation accepts both long-lived and expiring
token responses, but does not request additional data scopes.

The direct transport is feature-gated and disabled by default. Pipedream remains
available for other integrations. When the GitHub gate is disabled, existing
GitHub behavior is unchanged. When enabled, legacy Pipedream GitHub rows are not
treated as direct credentials and the owner must reconnect. They remain intact
for rollback until successful direct consent, after which the same transaction
activates the native connection and revokes the owner's legacy GitHub rows.

## Source of truth and data ownership

`github_oauth_connections` is the owner-scoped source of truth. It contains a
Matrix connection UUID, platform user UUID, immutable GitHub numeric user ID,
login, display label, optional public email, exact granted scopes, status,
revision, timestamps, and an encrypted credential envelope. The first release
has one logical GitHub connection per Matrix owner. `INSERT ... ON CONFLICT` makes a
repeated callback idempotent. The upsert and legacy-row retirement are one
transaction. Normal reads return only display-safe fields and never the envelope.

The credential envelope uses AES-256-GCM with fresh nonces and AAD bound to the
Matrix owner and immutable GitHub numeric user ID. It contains the access token and, when GitHub
issues them, refresh token and expiry timestamps. The dedicated encryption key
is required when the feature is enabled, must decode to 32 bytes, and must differ
from the GitHub client secret and existing platform/JWT/Pipedream/MCP secrets.
Tokens, OAuth codes, state, PKCE verifiers, client secrets, and envelopes never
appear in responses or normal logs.

Disconnect first claims the exact active revision so concurrent calls cannot use
or replace the grant, then revokes the provider token outside the transaction.
Successful or already-missing provider revocation deletes the row. A transient
provider failure retains a retryable `revocation_pending` state without making the connection
callable. Account deletion uses the same exact-row revocation lifecycle before
local deletion; encrypted evidence is retained only when remote revocation must
be retried. Refresh uses compare-and-swap on revision and encrypted envelope, and
never widens the previously granted scope set.

## Authorization matrix

| Route | Authentication and admission | Public |
| --- | --- | --- |
| `POST /api/integrations/connect` with `service=github` | Existing authenticated Matrix owner; bounded JSON; fixed service; gate and complete GitHub config required | No |
| `GET /api/integrations/oauth/github/callback` | Encrypted, expiring owner-bound state; exact callback URI; PKCE; single-use GitHub code; fixed redirect target | Yes, state-protected |
| `GET /api/integrations` and `GET /api/integrations/:id/status` | Existing authenticated owner; display-safe owner rows only | No |
| `POST /api/integrations/call` with `service=github` | Existing owner or already-authorized internal actor; exact active owner connection; existing selected-account and write-approval policy | No |
| `DELETE /api/integrations/:id` | Existing authenticated owner; exact owner/revision claim before remote revoke | No |
| `POST /api/integrations/:id/refresh` | Existing authenticated owner; exact owner/revision/envelope CAS; only for expiring grants | No |

Every mutating route retains Hono `bodyLimit` and Zod boundary validation. The
callback accepts only bounded `code`, `state`, `error`, and `error_description`
query fields; provider error descriptions are logged only as coarse classes and
are never reflected to clients. State is authenticated encryption over owner,
issued/expiry time, PKCE verifier, label, and a finite redirect-target enum.
Callback success and failure redirects are compile-time/configured allowlist
members; arbitrary return URLs are never accepted.

## Provider contract and transport

The implementation follows GitHub's documented web application flow:

1. Build `https://github.com/login/oauth/authorize` with the configured client
   ID, exact callback URI, `repo notifications`, unguessable encrypted state,
   and S256 PKCE.
2. Exchange the ten-minute code at the fixed GitHub token endpoint using the
   exact callback URI and verifier.
3. Validate the bounded token response and exact granted scopes, then call the
   fixed `/user` endpoint to bind the immutable GitHub user ID and login.
4. Store the encrypted owner-bound grant and publish the normal connected event.

All GitHub network calls use fixed HTTPS origins, `redirect: "error"`, a ten
second timeout, GitHub's recommended media type, and an explicit REST API
version. Token/profile/revocation responses are capped at 64 KiB; action
responses are capped at 1 MiB and 4096 chunks. Registry-owned paths, query
parameters, headers, and bodies remain the only provider inputs. User-controlled
URLs and headers are never forwarded. Provider status, bodies, and names are
logged server-side only in redacted/coarse form; clients receive stable generic
errors.

The direct executor preserves these action IDs and current schemas:

- `list_repos`, `list_issues`, `create_issue`, `list_prs`, `get_notifications`
- `get_pr`, `list_pr_reviews`, `list_pr_review_comments`, `list_pr_files`
- `list_pr_commits`, `list_check_runs`

Reads and the approved `create_issue` write continue through existing action
validation and approval gates. A `401` marks the connection expired; `403` does
not expose organization policy or upstream text; rate-limit responses remain
generic and do not trigger unsafe automatic mutation retries.

## Runtime wiring and rollout

Platform startup retains the existing Pipedream-backed integration runtime for
all non-GitHub services. The GitHub feature layers onto that runtime only when
its dedicated config is complete; enabling it without the base integration
runtime fails closed. Pipedream GitHub remains the rollback path while the gate
is disabled. Both public and internal
integration route registrations receive the same GitHub broker and owner
resolver. Startup fails closed when the gate is enabled with missing, reused, or
invalid secrets. Shutdown destroys the one owning database resource only once.

Web/Electron and Native Mobile keep consuming the shared catalog and connection
contracts. ENG-378 changes Web/Electron consent and popup completion; ENG-379
adds the separately reviewed native deep-link journey. Production enablement
waits until both UI slices are approved and their exact-head live evidence is
attached. Rollback disables the gate and leaves pre-consent legacy rows intact;
an owner who completed direct consent may need to reconnect through the restored
legacy path.

## Test-driven delivery and evidence

ENG-377 starts with failing tests for config isolation, state/PKCE/expiry,
partial-scope denial and immediate revoke, encrypted persistence, idempotent
upsert plus legacy retirement, owner isolation, direct dispatch of all eleven
actions, bounded responses, timeout/redirect rejection, refresh CAS, disconnect
failure recovery, account deletion, and startup with either provider configured.
PostgreSQL-backed tests cover transaction and unique-scope behavior. Focused
tests, typecheck, pattern checks, and applicable coverage gates must pass. Startup
tests cover the gate-disabled rollback path, complete native config, and fail-closed
partial configuration.

ENG-378 requires exact-head Web Desktop and Electron Desktop captures for
consent, connected, denied, and disconnect/recovery states. ENG-379 requires
exact-head Native Mobile dev-client/physical-device evidence for the equivalent
journey. Attach captures or accessible links to each PR, post the same evidence
with the ENG and PR links in Slack `#tech`, and link the Slack permalink back to
the PR. Record the exact commit/build and fixture or test-account limitations;
never commit evidence or expose credentials/private repository content.

## PR and documentation boundaries

1. ENG-377: this spec, provider/config/data model, OAuth lifecycle, direct
   transport, migration/recovery, account deletion, and backend tests.
2. ENG-378: Web Desktop and Electron Desktop settings/consent/completion only.
3. ENG-379: Native Mobile settings, deep link, and recovery only.
4. ENG-380: a separate public-safe `FinnaAI/matrix-os-site` documentation PR
   covering sign-in versus Connect Apps versus developer auth, scopes,
   supported actions, revocation, and recovery.

No slice changes Clerk sign-in, terminal `gh`/SSH authentication, non-GitHub
Pipedream services, or the eleven-action product catalog. Forced deletion of all
legacy Pipedream GitHub rows is deferred until the direct rollout is verified and
rollback no longer depends on those rows.
