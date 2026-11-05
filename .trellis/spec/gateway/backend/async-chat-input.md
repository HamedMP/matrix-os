# Deferred Chat answers

## 1. Scope / Trigger

A native Codex phase may continue waiting after `deferInput` sends the non-answer acknowledgement. A boundary-only answer queue cannot unblock that phase.

## 2. Signatures

`CanonicalChatProviderAdapter.submitDeferredInput?: CanonicalChatProviderAdapter['steer']` is an internal optional control. Only the existing Codex canonical adapter with native deferral implements it. Public answer payloads and endpoint authentication remain unchanged.

## 3. Contracts

Validate the answer against its original question before control delivery. Fence owner, Chat, run and native turn; include request/question identity in the native answer text. Wait for the question's deferral receipt. Serialize concurrent live answers in arrival order. Queue lengths/deliveries remain capped at16; run registry at128. Secret native inputs use their existing path.

## 4. Validation & Error Matrix

- Live control accepted: emit `input.resolved(reason='answered')` after receipt.
- Definitely released phase: preserve a boundary continuation in the original native conversation.
- Definite active-control non-delivery: `ChatInputNotDeliveredError`, restore pending input under its original deadline for retry.
- Uncertain transport delivery: preserve durable submitted claim; never replay automatically.
- Abort: drain controls and pending questions with existing cancellation semantics.

## 5. Good / Base / Bad

Good: a normal wait-for-answer prompt receives Alpha within the same active native turn. Base: an ended phase resumes the original native conversation. Bad: reporting submitted as answered, cancelling the run, opening another Chat, or withholding a second pending answer until phase completion.

## 6. Tests Required

`chat-async-live-input`, `chat-live-input-coding-provider` and `codex-deferred-input-continuation-runtime` cover fast, active, ended, concurrent and secret answers; completion-before-receipt; definite rejection; uncertain non-replay; actual runner/socket controls. Final acceptance requires an ordinary question from packaged Electron with matching Preview, then actual reply and Done in the same Chat/run.

## 7. Wrong vs Correct

Wrong: unconditionally enqueue the answer for after `run.completed`. Correct: use validated active native delivery when supported; otherwise retain the existing safe phase-boundary path. A prompt asking the model to end its phase before receiving the answer is a workaround and cannot certify normal question continuation.

## Long native question descriptions

### 1. Scope / Trigger

Native Claude `AskUserQuestion` may supply ordinary option explanations longer than
300 characters. A presentation validation failure must not terminate the Chat.

### 2. Signatures

`UserInputQuestionListSchema` and the Claude controller share
`MAX_USER_INPUT_QUESTIONS_BYTES = 64 * 1024`. The independent
`questionDescriptionVersion=1` query capability is the sixth argument of
`projectChatMessageResponse` / `projectChatMessageFrame`; its default is `"0"`.
`chatMessageVersionUrl` advertises the capability without changing `inputVersion=1`.
Native Mobile also uses this helper for detail reads, turn admission and SSE;
independently constructed capability lists can silently strip valid questions.

### 3. Contracts

Measure the complete serialized question list as UTF-8, including JSON escaping.
Check both the original native list and its canonical projection. Preserve native
counts, all other field limits, safe-display validation and sensitive-question
masking. Reject unsupported content before pending-state/timer registration using
an explicit native denial; never implicitly approve a tool. Transport write errors
still reach the existing error boundary; diagnostics contain fixed labels only.
Keep original native question keys and selected option labels for the stdin answer.

### 4. Validation / Error Matrix

Within budget and safe: admit the full canonical descriptions. Malformed, unsafe
or oversized: deny that tool request and permit a later supported question.
Absent/zero capability: project nonblank descriptions to at most 300 UTF-16 code
units without splitting a surrogate pair. Capability one: preserve full text.
Invalid/repeated capability: HTTP400 before service work or stream registration.
Existing endpoint auth, body limits, owner/run fences and deadlines are unchanged.

### 5. Good / Base / Bad Cases

Good: a 380/355-character pair is displayed and answered on the same native process.
Base: an old client parses a shortened display while the repository retains the
complete text; an old gateway ignores the new query flag. Bad: widening only the
gateway parser, truncating stored data or option labels, or treating a rejected
question as a fatal observer exception.

### 6. Tests Required

Use an independently worded public fixture. Cover real-adapter stdin continuation,
64 KiB exact/overflow boundaries with multibyte and escaped text, controlled denial
and transport-error privacy, HTTP/SSE capability validation and projection, durable
input/detail/export reads after a legacy read, cancellation, expiry, duplicate
answers, secret inputs and ordinary permission denial. Runtime visual qualification
records exact source/client provenance separately from synthetic transport tests.

### 7. Wrong vs Correct

Wrong: native `.parse()` throws on an ordinary long explanation, or an unnegotiated
response breaks released strict clients. Correct: shared bounded validation,
controlled local rejection, full canonical persistence and capability-specific
wire projection that never changes answer identity.
