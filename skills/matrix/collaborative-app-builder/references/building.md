# Building a collaborative app

## App and manifest

Use a normal owner-built Vite/React app with `scope: "personal"` and
`listingTrust: "first_party"`. The organization share delegates access without
transferring ownership. Never use those fields to relabel an imported untrusted app.

Start from the normal builder template, or copy this skill's `assets/team-tracker/`
into an unused `~/apps/<slug>/` directory. Keep the example's package scripts
portable; install dependencies with pnpm and commit the generated lockfile in the
app project. Choose its own name/slug, icon and design using the ordinary builder.

Declare columns as SQL type strings, for example `"columns": { "title": "text", "done": "boolean" }`.
Matrix supplies system columns such
as `id`; do not redeclare them. Copy the example manifest's `collaboration` object:

```json
{
  "capability": {
    "version": 1,
    "storage": "owner_postgres",
    "audience": "current_organization_members",
    "participantIdentity": "authenticated_actor",
    "mutations": "transactional_revisioned",
    "updates": "content_free_signal",
    "providerPolicy": "existing_authority"
  },
  "compatibility": {
    "bridgeContractVersion": "matrix-app-bridge-v1",
    "runtimeAbi": "matrix-runtime-v1",
    "schemaDigest": "calculate-from-the-exact-table-declaration"
  }
}
```

`schemaDigest` above is explanatory, not a valid literal. Run this skill's helper
with its resolved installed path:

```sh
node /resolved/skill/scripts/schema-digest.mjs /absolute/path/to/app
node /resolved/skill/scripts/schema-digest.mjs /absolute/path/to/app --write
```

The default prints SHA-256 of canonical JSON for `storage.tables`: recursively
sort object keys, preserve array order, and serialize without whitespace. `--write`
updates only the compatibility digest, preserving the other manifest values.
Repeat after schema edits, before building. The registered table declaration must
match this source; if it differs, inspect registration/schema drift rather than
inventing a hash. Readiness/build identity comes from Matrix, never this helper.

## Runtime bridge

The app receives `window.MatrixOS.collaboration` on supported owner and member
surfaces. Use this API for both, including before sharing and after Stop sharing.
Do not infer authority from participant metadata, or switch a member to a local
same-slug app/`MatrixOS.db` when collaboration fails.

- `query({ action: "find", table: "tasks", limit: 100 })` returns
  `{ result, revision }`. Use a bounded query and paginate larger collections.
- `mutate({ action: "insert", table: "tasks", data: { title: "Plan", done: false } }, revision)`
  returns `{ result, revision, replayed }`. Updates use `{ action: "update", table,
  id, data }`; deletes use `{ action: "delete", table, id }`. Pass the revision as
  the string returned by the bridge, not the manifest/build/share revision.
- `onChange(callback)` returns an unsubscribe function. Treat it as invalidation:
  reread authoritative records, preserve unfinished edits, and unsubscribe on unmount.
- `participant` supplies safe display/actor metadata, which may be null for an
  unshared owner. It is not an authorization or permission API.

Serialize writes within the app. Never replace a read failure with an empty saved
dataset, never clear input on an unconfirmed write, and do not automatically replay
`mutate` after failure. Matrix handles operation IDs; submitting a new call creates
a new operation. Use Matrix's Retry overlay when offered. The owner bridge also
supports `retryMutation()` with no owner Retry overlay: offer an explicit action
when that method exists, as the tracker does. It replays the transport's original
operation; never replace it with a fresh `mutate` call. The member bridge does not
expose it and uses Matrix's overlay instead. After recovery reread and show what saved;
keep drafts until confirmed or deliberately discarded. Conflicts require review.

The tracker demonstrates bounded reads, CRUD, rereads, a stable inserted row ID,
retained drafts and pending writes, and subscription cleanup. It deliberately
offers no automatic conflict overwrite or new-operation retry. Adapt its single-page
limit before using it for larger datasets. Multi-operation related writes need an
existing atomic server operation or a schema redesign; `db.transaction()` does not exist.

Build reachable, actually used code. Matrix's current readiness preflight inspects
loaded built scripts conservatively; dummy calls, comments, unused functions, and
metadata-only reads are not capability proof. Run the real readiness check after
every relevant rebuild, and run the rendered two-account journey separately.

Keep the example's ES2022 target, classic React JSX output, and unminified function
names for this verifier version. Older-target optional-chain rewrites and aggressively
minified React bundles can obscure real bridge calls or exhaust the conservative
inspector. These settings preserve the working application rather than adding
dummy proof calls. If changing them, rerun the actual production verifier on the
resulting bytes before recommending the new configuration.
