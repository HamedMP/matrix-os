# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (model adapter and prompt, kernel tool, UI, organization scopes, scheduled extraction, cross-extractor de-duplication, claim search) is named, not implied.
- [x] The three tables, their keys, CHECKs and indexes, the claim id tuple and normalization, UTF-16 body offsets with the verbatim-quote rule, replace and stale semantics and the pending rule are stated.
- [x] The rules grammar (sections, items, labels, kind prefixes, confidence, bounds) is grounded in the survey of real PR bodies, and the Deferred scope commitment rule is decided from its numbers.
- [x] Rules versions are stated: the version constant, pending under a new version, one rules generation per document (older claims and state removed in the write transaction), reads during and after the change, model rows untouched, the unchanged claim id recipe.
- [x] Model output verification is specified (strict candidate schema, requested kinds, verbatim quote location with whitespace-run normalization, de-duplication, caps, rejected counts, usage validation) with no model wired.
- [x] The job states its limits, budgets, stop conditions, per-document transactions, error codes and next actions, the in-process guard, the run lease and the run-id fence.
- [x] Routes list input bounds, bodies, status codes, new error codes and `Cache-Control`; extract is one bounded run per request and `model` is a 409 until configured.
- [x] Security architecture, integration wiring, failure modes, resource limits, the five invariants, the integration test checkpoint, review checklist and delivery are recorded; OS-view matrix N/A with a rationale.
