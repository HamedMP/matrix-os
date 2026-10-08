# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (summary model and spend records, organization scopes, delivery to chat or mail, model-based conflicts, per-user settings) is named.
- [x] The table, its key, CHECKs, lock and retention, the UTC windows on source time, and the rule for claims first seen in a window are stated.
- [x] Each section's content, order and caps, the line shape with cites, and when a stored brief is served or rebuilt are stated.
- [x] The three conflict rules are precise and grounded in this repository's data (same label alone is noise; Draft specs with later work exist), with ids, sides and caps.
- [x] The four stale kinds state when an item is stale and what `since` means.
- [x] Routes list inputs, bounds, paging, status codes and the summary error; the summary flag is off by default and no model ships.
- [x] Security architecture, integration wiring, failure modes, resource limits, the five invariants, the integration test checkpoint, review checklist and delivery are recorded; OS-view matrix N/A with a rationale.
