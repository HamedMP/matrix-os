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
- `ai.routes()` requires the connected-AI gateway layer; until then discovery is unavailable.
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

App AI continues to use the existing owner `system/app-ai.json` policy with
`apps` and `model`. Explicit connected routes and discovery remain unavailable
until the connected-AI layer is installed; selecting a route fails closed.

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
route-discovery calls before network work. Native Mobile binds calls to the launched
app and navigation document, drains pending calls on unmount and holds fresh
owner credentials in the native host. Web rejects aliases of privileged endpoints.
Native Mobile verifies the full installed identity and runtime slug against the
authenticated gateway catalog before creating a session. Route/deep-link aliases
are hints; missing, mismatched or ambiguous catalog pairs fail closed. The verified
pair binds the preview and broker, preserving nested app storage and grants.

The host exposes AI discovery and generation methods. This host layer preserves
legacy generation; connected route discovery becomes available with the
connected-AI gateway layer. Chat integration reads ship in the final Chat layer.


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
