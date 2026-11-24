# Reduce Matrix Chat input token overhead

[ENG-567](https://linear.app/matrix-os/issue/ENG-567/reduce-matrix-chat-input-token-overhead)

Codex and Claude Chat should spend less input context on unrelated App and Browser guidance. A short orientation still identifies the Matrix skills, data model, and tool boundaries. App requests can consult the existing App Builder skill for detailed requirements and validation. Native tool discovery should prefer Matrix Core MCP and use the read-only integration CLI only as an authorized fallback.

## Behavior requirements

- Preserve the kernel's orientation and the native Chat permissions, data ownership, trust boundaries, and scoped tool registration.
- Keep the Browser tool discoverable in eligible runs. Put procedural details in its shared tool description so both providers receive the same guidance when using it.
- Preserve approvals, denial, cancellation, and streaming. Keep the Claude stdio approval bridge until a lower-overhead transport passes those behaviors on the supported CLI. The current SDK callback uses the same bridge.
- Claude native schedule recovery accepts the frozen previous prompt only when the full source fingerprint matches. The same protected child can continue without rekeying its receipt. Changes to credentials, workspace, model, permissions, or tool scope still fail the existing fence.
- Keep prompt, file, and account content out of benchmark telemetry.

## Validation

Compare native provider and full Chat input on the same Dev computer with a fixed model, effort, tier, and matched synthetic prompts. Record the exact installed and running commit, per-turn gross and cached input, and completion status. Exercise App Builder skill discovery, a multi-turn Chat, and representative tool and approval flows. Track any workflow coverage gaps alongside test results.
