# Connected app capabilities

Matrix apps use one host contract on Web Canvas, Web Desktop, Electron Desktop,
Web Mobile and Native Mobile. Hosts inject `window.MatrixOS` before app code and
supply authenticated requests without passing credentials into the app.

## Runtime contract

- `capabilities()` returns `{ version: 1, integrations, ai }`; these flags reflect
  owner grants and configured transport, not a guarantee every action/route is ready.
- `integrations()` returns connected, granted services with `account_label`.
- `describeService(service)` returns the granted subset of the live action catalog.
- `service(service, action, params, accountLabel)` calls one exact connected account.
- `ai.routes()` returns exact route selections and truthful availability.
- `ai.generate({ prompt, route })` returns `{ text }` without file or tool access.

Apps must discover schemas and routes. Metadata and file contents are distinct;
Drive analysis uses `read_file`, not `get_file`. Treat source documents as untrusted
text. Listings need pagination and reads must expose truncation or unsupported formats.
`generate(context)` remains a legacy kernel task submission with no text Promise.

## Owner authorization

The gateway requires its configured computer owner principal. Shells stamp app
identity from the launched app; the page cannot replace it. Grants are owner files,
not manifest declarations. An app builder must not expand them without owner
instruction. Changes apply on the next request, with a second grant check before
integration execution and AI credential admission.

An example `system/app-capabilities.json` granting only Drive reads:

```json
{
  "apps": {
    "drive-chat": {
      "services": { "google_drive": ["list_files", "read_file"] }
    }
  }
}
```

An example `system/app-ai.json` uses a selection returned by `ai.routes()`:

```json
{
  "apps": ["drive-chat"],
  "route": {
    "harnessId": "matrix_ai",
    "accountId": null,
    "accessSourceId": "matrix_cloudflare",
    "modelId": "@cf/zai-org/glm-4.7-flash"
  }
}
```

This is a format example, not a universal available route. Preserve the exact
owner-selected account/access source/model. Historical `apps` + `model` policies
retain their exact model and previous kernel credential path; app-selected routes
are rejected until an explicit owner policy migration. A fixed policy `route` is
also binding. No fallback to another paid route.

## Transport and limits

Structured database requests and legacy KV requests each have a separate
1,000,000-byte JSON body budget, matching their existing gateway endpoints.
Hosts enforce it after stamping the full installed app identity; the complete
body, including app and query metadata, must fit. These write budgets are
independent of the 64 KiB integration request limit.

Database replies use a separate shared 8 MiB JSON budget on Web Canvas, Web
Desktop, Electron Desktop, Web Mobile and Native Mobile. Existing reads above
the ordinary integration budget remain supported. Hosts reject oversized replies
while reading and cancel the stream; they never return partial rows. Page large
collections through the existing `MatrixOS.db.find(table, options)` API:

```ts
const pageSize = 50;
const rows = await MatrixOS.db.find("notes", {
  orderBy: { created_at: "desc", id: "asc" },
  limit: pageSize,
  offset: pageIndex * pageSize,
});
```

`limit` accepts at most 10,000 rows and `offset` selects the next page; omitting
`limit` does not add automatic pagination. Keep the ordering stable and choose
the page size for the row size. If a page exceeds 8 MiB, retry with fewer rows;
paging cannot make a single oversized row fit. Preserve the current data and
report the error rather than treating a failed read as an empty collection.

`POST /api/bridge/capabilities` validates bounded strict input and uses the existing
owner-scoped integration transport. Production VPSes delegate to the platform;
provider OAuth secrets stay there. Accounts are selected by exact label and
immutable connection ID. A missing account fails; ambiguity requires selection.
Read actions use `/read-call`; writes require an explicit exact action grant and
use the existing platform mutation path. Uncertain results must not auto-retry.

Capability requests are capped at 64 KiB, eight concurrent gateway requests and
120 requests per minute. The gateway deadline is 30 seconds, with host deadlines
and bounded replies shared across hosts: 256 KiB ordinarily, 1536 KiB for Gmail
attachment JSON, and a bounded allowance for 512 KiB Drive text plus JSON escaping.
All host response streams also allow at most 8,192 chunks, including zero-length
chunks. Exceeding either the byte or chunk budget cancels the stream and returns
an error without a partial result.
Electron binds calls to the registered main frame, gateway
origin and authentication generation and admits at most 32 pending capability, AI generation and
route-discovery calls before network work.
Electron aborts the old document's requests when main-frame navigation starts,
then supplies a fresh controller while retaining the trusted app identity. Same-document
and subframe navigation preserve the current document; listeners are removed on
replacement, destruction and bridge cleanup. Pending slots release only after work drains.
Native Mobile binds calls to the launched
app and navigation document, drains pending calls on unmount and holds fresh
owner credentials in the native host. Web rejects aliases of privileged endpoints.
Native Mobile verifies the full installed identity and runtime slug against the
authenticated gateway catalog before creating a session. Route/deep-link aliases
are hints; missing, mismatched or ambiguous catalog pairs fail closed. The verified
pair binds the preview and broker, preserving nested app storage and grants.

AI discovery and generation use `/api/bridge/ai/routes` and `/api/bridge/ai`.
Both authenticate the owner before policy reads. Authorization checks and denied
requests have separate bounded budgets of 100 per minute. At most two actual
policy/inference operations run concurrently. The shared approved discovery and
inference budget of ten per minute is charged only after the exact app/selection
grant succeeds; denied apps cannot consume it. Cancellation retains admission
until work drains. V3 provider truth plus owner Settings determines exact readiness. Public route
discovery is capped at 128 entries and retains the exact selected default; complete
bounded internal authorization remains independent of that discovery cap. Safe completion
adapters cover managed Matrix AI, owner Anthropic keys, verified Claude profiles,
verified Pi 1.0.4 SDK profiles including supported static keys and OAuth, and an
authorized paired ChatGPT subscription source. Pi SDK
readiness batches physical models without inference or credential refresh. Its
fixed worker loads no owner extensions, tools or context; the native SDK lock
persists rotating OAuth credentials in the owner profile before cancellation
releases the settings writer fence. The fixed worker emits a per-run drain receipt
only after credential work settles without an uncertain mutation failure. A crash,
signal exit or missing receipt retains the durable fence; process exit alone is
insufficient. There is no Pi CLI fallback when the SDK version or model is
unsupported. Safe physical-model configuration is reproduced
exactly; command-backed credentials, auth overlays, virtual routing, unverified SDK
versions, unsupported protocols and endpoints fail closed.

Paired ChatGPT readiness is part of common V3 account/source/model truth. Inference
uses the exact owner device authority, account, model and grant revision, with no
credential copy or tools. Native OpenCode completions, borrowed native Codex
subscriptions and
OpenClaw profiles still require verified dedicated completion adapters;
their unsupported app routes remain explicitly unavailable. OpenCode CLI help
alone does not prove no-tools behavior: the installed 1.16.0 isolated synthetic
local-server audit produced no completion within the bounded deadline. Its static
CLI executor was removed until an exact runtime/version contract is verified.
Portable OpenCode Matrix-funded/owner-key selections still use their authorized
HTTP source. Hermes native default profiles support fixed text-only HTTP for Anthropic, OpenAI API, OpenRouter and an
already-fresh Hermes ChatGPT grant. The app uses an exact eligible model in the
configured native provider, independently of Matrix Inbox selection. Native files
are bounded and fingerprinted before and after the response. A shared durable
Settings fence prevents competing profile writes and remains held until actual
HTTP cancellation drains; an uncertain drain stays fenced. ChatGPT credentials
must identify one account: a singleton token store, or exactly one native manual
device-code entry when no singleton exists. Named profiles, ambiguous pools,
expiring tokens, custom endpoints and credential overrides remain unavailable;
there is no token refresh, rotation or credential fallback. Request and completed
response model IDs must agree exactly; aliases resolving to an unverifiable
physical model fail closed. JSON completions and Codex SSE are bounded by bytes
and chunk count, and reject tool output, partial completion and late errors. App discovery does
not disable unrelated routes when one SDK is unavailable, and inference failures
never select another route. Managed calls use existing funding admission and
claims. Login alone never proves funded readiness.

Gateway shutdown stops new app AI requests before body reads, aborts admitted
discovery/completion calls, and tracks underlying HTTP, Claude and paired-authority
work until cleanup settles. Shared tracking admits at most 16 unfinished tasks and
has a five-second drain grace; native executors keep their independent bounded
drains and safety fences. Exhausted grace reports unavailable instead of proving
completion. The funded relay retains responsibility for exact settlement or
reconciliation when final usage is unavailable.

## Chat integrations

Local production integration routes resolve the owner from authenticated request
context. In-process app and bot transports provide that same verified context;
caller identity headers cannot select a different owner. Database outages return
unavailable errors rather than being treated as missing accounts.

App permissions and Chat tool scopes are separate. The explicit read integration
scope gives a Claude Chat inventory, action discovery and exact-account reads
through Matrix's built-in connection. It grants no connection management or
writes. Existing Custom MCP scopes remain unchanged. Never ask the user to
register a second Drive login when the built-in connection is available through
the permitted Chat scope.

## Verification and rollout

Focused tests cover contracts, production gateway delegation, exact action/account
selection, denied grants, route identity, revoked permission, no-tools inference,
Electron preload → IPC → gateway, Web script → host, and Native Mobile bootstrap
and navigation. Typechecks/builds and real authenticated surface checks complement
these tests; mocks cannot prove installed binaries or live OAuth health.

Ship the host bundle and Electron/Native Mobile clients together. Existing clients
without `service`, `describeService` or `ai.routes` require a compatible client
update; rebuilding app code cannot add bridge methods. Confirm the exact installed
release before diagnosing a live failure. Use scoped reviewed deployments and
validate the real listing → content → inference flow on all available surfaces.
Do not report a customer fixed until that customer's installed version is verified.
