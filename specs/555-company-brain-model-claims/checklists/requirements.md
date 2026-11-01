# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit: an owner-triggered Claude Opus 5.5 extractor next to `rules/v1`; deferred work (disconnect stop, batches, token pre-estimates, OAuth or cloud-provider credentials, per-kind prompts, 1-hour cache, per-code counters, cross-extractor de-duplication, organization scopes, scheduled runs, UI, kernel tool, spend display) is named, not implied.
- [x] The request is fixed: model id, effort default, `max_tokens`, `fallbacks: "default"` with its beta value, the cached system block, structured output format, the parameters never sent, and the prompt version that names the claim set.
- [x] The prompt and output rules are stated (four kinds, untrusted-data rule, verbatim quote and statement, at most 20 claims, the loose wire schema and why), and every candidate still goes through spec 554's verification.
- [x] Newest-first selection and the skip codes (`document_too_large`, `body_too_short`, `commit_list_only`, `model_refused`) are grounded in the 2,129-document corpus table.
- [x] Every SDK error class, refusal and unusable response maps to a code, a document effect and a next action, by class and never by message text.
- [x] Usage and cost are specified: per-attempt pricing over `usage.iterations`, cache read and write counts on the run row, integral micro-USD rounded up, and the per-run overrun bound.
- [x] Configuration, credential order (owner key, else a direct environment key, else 409) and the third-party data flow (what is sent, never sent, from which scope and provenances, opt-in, retention, what Matrix stores) are written plainly.
- [x] Security architecture with the egress row, integration wiring, failure modes, resource limits, the five invariants, the integration test checkpoint with a capped manual run, review checklist and delivery are recorded; OS-view matrix N/A with a rationale.
