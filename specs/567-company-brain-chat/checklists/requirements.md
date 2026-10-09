# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; the app side and deferred work (deep links, `brain.read` for Matrix AI
      Chats, run-scoped MCP tools, whole-document reads, brief metering, Opus 5.5, an eval set) are named, not
      implied.
- [x] Bot chats stay out of the `matrix_chat` brain source (picker, scans and sweep), and a gateway with no runtime
      host makes no thread.
- [x] The Bot's capabilities, limits, unlisted recipe and server-owned rules are stated; owner edits change only the
      style.
- [x] The brain-only tool rule is enforced in the contract, the worker, the run and the broker, and each place is
      named with its refusal code.
- [x] The thread binding, its migration, both routes, replay and conflict rules, the cap and the list order are
      stated.
- [x] The effort setting is opt-in per recipe, limited to Anthropic models that think adaptively, and never sends a
      disabled thinking field.
- [x] Security architecture, integration wiring, failure modes, resource limits, the five invariants, the integration
      test checkpoint, the review checklist and delivery are recorded; OS-view matrix N/A for the server side.
- [x] App side: tabs, chat slot, hosts on every surface, Open in Chat, unavailable states, accessibility and the
      OS-view matrix are specified in spec 563.
- [ ] Real run under $1 on a capped key, with answers checked for links and tool calls, on a host with the
      scope-runtime supervisor (not the Docker dev setup).
