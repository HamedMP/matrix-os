# Shared app bridge result serialization follow-up

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29).

## Problem

Shared Tasks Lab could not load its owner's existing task. The scoped app bridge
returns node-postgres rows, which carry `timestamptz` and `date` columns as
JavaScript `Date` objects. The app-instance and project app adapters validated
those raw rows with `z.json()`, rejected them, and mapped the rejection to
`unavailable` (HTTP 503) for the owner and every member. Refresh repeated the
same failing read. The app then showed its initial `Tasks 0` state, which looked
like a successful empty result.

## Intended behavior

- Before strict validation, `collaboration/bridge-json.ts` converts a bridge
  result to the wire value the owner's direct bridge already returns through
  `c.json()`: a valid `Date` becomes its `toISOString()` instant (UTC,
  millisecond precision). Strings, booleans, finite numbers, `null`, arrays,
  and plain records keep their exact shape. A JSONB `__proto__` key stays data.
- Every other value fails closed as `unavailable`, with only a reason code in
  the server log: non-finite numbers, invalid dates, `bigint`, `undefined`,
  functions, `Buffer`/typed arrays, `Map`/`Set`, other class instances, nesting
  deeper than 64 levels, and results above the existing byte limits (1 MiB app
  results). Nothing is stringified implicitly. Partial results are never returned.
- Owners and organization members receive identical data through the same
  owner-backed path. Authorization, transactions, revisions, replay records,
  change events, and credential isolation are unchanged.
- `date` columns follow the owner bridge: node-postgres parses them at local
  midnight in the gateway process time zone, and both paths emit that instant.

## App states (Shared Tasks Lab reference app)

A failed first load shows "Shared tasks didn't load" with Try again. It shows
no task count or revision, and the composer stays disabled until a real
revision exists. A failed refresh keeps the last successful list and explains
that it may be out of date. "No tasks yet" with `Tasks 0` appears only after a
successful empty read. Copy never exposes database or provider errors and no
longer blames the user's connection for a server failure.

The app lives in the owner's home, not in this repository. The UI change ships
as a separate, backed-up owner patch. It is not deployed by this PR.

## Acceptance

| Actor and starting state | Action | Observable completion | Failure/recovery | Authority/data boundary | Surface and test/lane |
| --- | --- | --- | --- | --- | --- |
| Owner and org member; one existing timestamp-bearing task | Load list | Both receive the same row with ISO timestamps at revision 0 | NaN or oversized row returns `unavailable`, other rows stay readable | Owner Postgres through scoped bridge in the locked transaction | Gateway; `collaborative-app-two-home-postgres.test.ts` (PGlite) |
| Member | Update, then owner deletes | Revisions 1 and 2, two content-free change events, reload reflects both | Stale writer still rejected as `conflict` | Unchanged authorization and replay | Same suite |
| Project scope member | Read dated project rows | Owner and editor receive identical ISO values | Same converter policy | Project scope transaction | `collaboration-project-apps.test.ts` |
| Any | Unsupported value | Rejected by reason, never stringified | Size/depth limits enforced | No raw value in logs or responses | `collaboration-bridge-json.test.ts` |
| Member with failing reads | Open app, then Try again | Failure panel without count; retry loads the task | Refresh failure keeps last list | No raw errors shown | Built app + fixture bridge, 390/1024 px (renderer evidence only) |

Live owner/member qualification on Web Canvas, Web Desktop, and Electron
Desktop requires a deployed build and two signed-in accounts. Fixtures do not
establish it.

## Risks

- Timestamp precision is milliseconds, as on the owner bridge; Postgres
  microseconds are truncated by node-postgres before this boundary.
- A table that adds an unsupported column type outside the manifest type map
  fails closed until that type has a defined wire representation.
