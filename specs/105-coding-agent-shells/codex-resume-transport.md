# Codex resume transport (MAT-525)

A successful image-generation turn can leave several megabytes in the native
history. Returning that history in `thread/resume` exceeded the old 1 MiB JSON
line limit. The runner silently discarded the response and failed at the
30-second RPC deadline, before dispatching a new turn.

## Implementation

Request `excludeTurns: true` only on `thread/resume`. Matrix needs the native
thread identity, not a replay of its history. Codex still restores the complete
model context; the option changes the response projection, not stored history.
The option was verified against a real Codex CLI 0.147.0 app-server: a synthetic
image history produced a 3,063,937-byte response without it, and approximately
1.3 KiB with it. This does not establish identical behavior for every version.

Older providers may ignore the projection option. A separate transport reader
accepts replies up to 16 MiB, including a 3 MiB image-history reply. Existing
1 MiB tool/text validation limits remain unchanged. The reader grows a bounded
byte buffer geometrically, checks the limit before copying each fragment, and
parses complete frames sequentially. It does not accumulate a queue of frames.

Malformed JSON/UTF-8 or frames over the transport bound fail promptly. The
runner logs only the category, observed byte count, configured limit, and a
bounded list of locally issued pending RPC methods. It then uses the existing
provider stop/drain and failed-turn path. No history, provider error strings,
images, or credentials are logged. The observed count may be a lower bound for
an incomplete oversized frame.

This extracts the byte-framing responsibility from the large runner. Native
protocol schemas, turn dispatch, approvals and persistence remain in their
existing owners. No endpoint, database, auth policy or terminal quota changes.

## Validation

- `tests/gateway/codex-resume-transport.test.ts`: real runner subprocesses;
  providers respecting/ignoring the option, one resumed turn, safe failure for
  oversized/malformed replies, no image payload persisted in the event stream.
- `tests/gateway/codex-provider-output.test.ts`: byte boundaries, fragmented
  frames/UTF-8, CRLF, final frames, malformed input and handler failure.
- Existing app-server runtime, reliability and event suites cover the unchanged
  approval, input, cancellation, output and lifecycle behavior.
- Isolated live model check: retain a verification code in synthetic history,
  restore a thread containing a 3 MiB image event, and ask the model for that
  code without repeating it in the new prompt. Compare concatenated streamed
  deltas and require a successful completion with the same native identity.

Customer attribution requires matching the deployed provider/runtime versions
and validating the actual continuation. A reproduced transport bug alone is
not proof that every historical generic failure has the same cause.
