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
