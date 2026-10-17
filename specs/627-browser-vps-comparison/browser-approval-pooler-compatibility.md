# Browser approval lookup through transaction poolers

Follow-up within [MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix)
and [browser stack #2689](https://github.com/HamedMP/matrix-os/stacks/2689).

## Goal and scope

Save signed browser decisions when Platform connects through a PostgreSQL
transaction pooler that rejects server timeout settings in its startup packet.
Keep the existing owner, runtime, activation and deletion predicates unchanged.
The existing permission card and failure copy stay unchanged across all surfaces.
Ask the browser-stack and Platform reviewers to assess this connection-boundary fix.

## Connection and transaction lifetime

Retain the private two-client pool, eight-operation admission cap, three-second
connection limit and five-second client query timeout. Send no server settings
as startup parameters. On one checked-out client, start a read-only transaction,
set statement, lock and idle transaction timeouts with `SET LOCAL`, run the
parameterized ownership lookup, and commit before returning a result.

Local settings expire with the transaction, including with transaction pooling.
Any setup, lookup or commit error destroys the connection and returns no authority.
Shutdown still physically destroys checked-out connections and drains operations.
No new endpoint, credential, schema, authorization fallback or default feature
enablement is introduced. Existing signed owner proofs remain mandatory.

## Acceptance

- Reproduce startup-packet rejection and verify the same bounded read succeeds
  with transaction-local settings; diagnostics expose only coarse results.
- Regress connection configuration, exact predicates, timeout lifetime, failed
  setup/query/commit, one-time release and shutdown during an in-flight lookup.
- Require CI and Greptile before a separately approved candidate deployment;
  retest live Not now, Allow once, Chat grant persistence and Undo afterward.
- Keep [public usage docs PR](https://github.com/FinnaAI/matrix-os-site/pull/260)
  qualified by the actual live results; never describe a visible card alone as
  successful signed permission acceptance.
