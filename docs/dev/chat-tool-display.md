# Chat tool display and replay

Codex tool lifecycle records must retain their identity even when optional
preview text cannot be displayed. A command preview uses the thread event's
1,000-character/4,000-byte bound; working-directory detail uses its
2,000-character/8,000-byte bound. Neither field is a 120-character tool label.
Rejected optional metadata is omitted independently. An incomplete preview/kind
pair is omitted together, without discarding the start event.

The detached Codex runner publishes bounded command output and text blocks from
MCP results. Sensitive output or sensitive command/argument context is withheld
before journal persistence. Unsupported result envelopes retain a coarse result
notice. Output is capped at 4,000 characters and reports truncation. Canonical
Chat independently validates tool output against its client-safe output contract;
other coding harness outputs pass through that same publication boundary.

Canonical activities remain the source of truth for live delivery and reload.
Renderers combine working-directory/status detail with tool output instead of
letting one hide the other, cap expanded detail at 16,000 characters, and mark
truncation. Web Canvas, Web Desktop and Web Mobile share the Web Chat component;
Native Mobile shares the activity projection and offers a bounded expandable
result. Electron Desktop retains its existing activity presentation and copy
command action. The legacy project transcript now displays its validated command
preview and working directory, while retaining its payload-free output summary.

Existing consecutive-tool grouping remains in place. This fix does not introduce
new grouping rules, expose arbitrary raw argument objects, or reconstruct data
that an older runner/parser already discarded. It does not change execution,
authorization, database ownership, or share/export visibility rules.

## Regression checks

- `tests/gateway/codex-tool-display-contract.test.ts`: long commands, long
  directories, malformed/unsafe optional fields and multiline results.
- `tests/gateway/codex-tool-output.test.ts`: safe text, private context and size
  bounds before journal persistence.
- `tests/gateway/chat-coding-provider.test.ts`: live and snapshot replay retain
  output through the canonical adapter.
- `tests/gateway/coding-agents-codex-app-server-reliability.test.ts`: a spawned
  detached runner journals a long command and its result, then replays both.
- `tests/desktop/chat-tool-output-parity.test.ts`: desktop/web/mobile projection
  retains preview, metadata, result and truncation after serialization/reload.
- `tests/shell/tool-call-details.test.tsx` and Native Mobile
  `__tests__/chat-tool-activity.test.tsx`: expandable output and status.
- `tests/e2e/desktop/chat-tool-details.e2e.test.ts`: built Electron Desktop with
  a disposable profile and synthetic gateway; open Chat, select Tool details
  review, expand Worked for and Run command, then repeat after reload.

For the Electron check, build with `bun run build:desktop`, then run
`MATRIX_DESKTOP_E2E_REQUIRED=1 pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/chat-tool-details.e2e.test.ts`.
Evidence is written to `output/chat-tool-details/`; the disposable profile and
gateway are cleaned up after the test. This fixture check is not a production
provider call or human approval.
