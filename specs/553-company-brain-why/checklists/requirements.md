# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (organization scopes, scheduled sync, UI, fetching, ranking, forge data, erasing a deleted project's scope) is named, not implied.
- [x] Project resolution, the `personal:project:<projectId>` scope recipe, one git source per scope and the registration `externalRef` rule are stated.
- [x] The query defines path normalization, the collation "C" range predicate (no LIKE), the new index, the count cap, the strict keyset cursor and every item field; excerpt extraction and its fallback are deterministic and verbatim.
- [x] Routes list input bounds, bodies, status codes and `Cache-Control`; foreign and missing projects are the same 404; sync is one bounded run per request.
- [x] The agent tool states registration, input, owner binding, read-only status, answer texts, hard length caps and how untrusted text is cleaned and wrapped.
- [x] Security architecture (auth matrix, validation plan, error table, credentials), integration wiring, failure modes (including a deferred bootstrap), resource limits and invariants (including the acceptable orphan state) are recorded.
- [x] Integration test checkpoint (including source-order wiring and the agent path end to end), review checklist, delivery and relationships are recorded; OS-view matrix N/A with a rationale.
