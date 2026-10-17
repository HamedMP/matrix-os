# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (a Settings screen for the key, other providers, approximate vector index, organization and cross-project search, suggestions, extra ranking signals) is named, not implied.
- [x] The OpenAI provider (request, limits, retries, error mapping, cost and its source), the owner settings and key order, the array store (CHECK, nearest in SQL with measurements, per-scope cap), the refresh budget and the third-party data flow (opt-in by key) are specified.
- [x] The tables, foreign keys, field weights, the pgvector detection rule and capability values are stated; the index states what pending means, its limits, batch size, budget checks, embedding checks, orphan handling and how hooks map to refreshes.
- [x] The query grammar, the tsquery construction without raw text, filters, scoring, paging, fusion, cursors, snippets, cites and routes (inputs, bounds, statuses, `Cache-Control`, `vector_search_unavailable`, the auto-mode fallback) are specified.
- [x] Security architecture, integration wiring, failure modes, resource limits with third-party data flow, the five invariants, the integration test checkpoint with a manual Docker scenario, review checklist and delivery are recorded; OS-view matrix N/A with a rationale.
