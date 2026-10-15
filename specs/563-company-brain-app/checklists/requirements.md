# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (Native Mobile, per-kind settings, option filter and paging, settings edits, alias edits, impact, why, stale list, in-shell citations, brief history) is named, not implied.
- [x] Every screen states what it shows and does; the client has one method per route; the project list source and every list bound are stated.
- [x] Loading, empty, error, permission, brain-off, not-turned-on and not-connected states are specified, and server text never reaches the screen.
- [x] Security architecture covers authentication, input bounds, encoding, link safety, logging, and the confirmed model run's data flow to Anthropic and its spend; no credentials pass through the view.
- [x] Integration wiring names every Web and Electron Desktop file that registers the app and the view registration values; no environment variables or dependencies.
- [x] Surface parity: one shared view; Web and Electron adapters only.
- [x] Failure modes (timeouts including the 30 s proxy limit for model runs, request ordering, one action per card, revision checks, error propagation) and resource limits are recorded.
- [x] The five invariants, the OS-view surface matrix, accessibility, the integration test checkpoint, review checklist and delivery are recorded.
