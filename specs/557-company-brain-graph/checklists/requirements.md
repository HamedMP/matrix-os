# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (tracker-key and handle mentions, organization scopes, graph search, kernel tool, app screens) is named, not implied.
- [x] The four tables, their keys, CHECKs and indexes, entity and link ids, alias rules and the derivation table (source, link type, mode) are stated.
- [x] Hook reactions, refresh order and bounds, freshness, dependent re-derivation and the decision digest are specified.
- [x] Routes list inputs, bounds, defaults, success views, error codes, cursor binding and `Cache-Control`.
- [x] Security architecture, integration wiring (no shared file edited; final wiring steps listed), failure modes, resource limits, the five invariants, the integration test checkpoint and the review checklist are recorded; OS-view matrix N/A with a rationale.
- [x] Delivery names the stacked PRs under 3,000 additions each, the separate `FinnaAI/matrix-os-site` docs PR and the Greptile 5/5 merge gate.
