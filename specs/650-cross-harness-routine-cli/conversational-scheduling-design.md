# Conversational scheduling by actual Chat capability

Status: implementation approved by the owner on 2026-11-07: remove Persistent task, keep Claude Code on its own schedule feature, use the existing routine CLI conversationally for Chat without native scheduling, retain review/results in the source Chat, then verify Dev before updating the English full-Chat demo.

This supersedes the explicit Persistent task route choice in source-chat-and-native-coexistence-design.md. The existing origin/approval/delivery, identity, cancellation and persistence contracts remain authoritative. Exact parent: Draft #3198, `6ea9a385bb9ec3d211a1cd95d8666ae74d71b2e2` (verified open/Draft/unmerged at start). Work is isolated from the parent/A/main checkouts.

## Product behavior

- User states the scheduling request directly in an ordinary private Chat. No creation button, scheduler picker or Settings schedule-enable permission.
- Claude Code creates new schedules through its native schedule tools. An unavailable native prerequisite is an unavailable operation, not an automatic switch to Matrix.
- A qualified Chat adapter without an offered native scheduling capability exposes the existing routine tool/CLI. The agent recognizes intent; the host authorizes the actual tool call. Do not add a server natural-language regex, a second discovery registry, a new MCP executor, or per-harness schedulers.
- Existing eligible private Bot destination is reused. Missing/invalid destination is a clear recoverable prerequisite using the existing destination selection flow; do not create or guess a Bot. The model cannot select owner/Chat/Bot/run/account/grant identity.
- Creation remains a proposal. The exact task is activated through independent owner review in the original Chat; scheduled canonical Bot results are projected back there. Existing Schedules management/history and Bot history remain valid.
- Source operation authorization, per-task activation, background model consent and integration permissions remain separate. Full Access is not a schedule activation or implicit permission renewal.
- Existing routine reads/reconciliation/pause/resume/archive remain available to their currently authorized sources, including Claude, without creating a new task or hiding historical origin.

## Trusted route and compatibility

Reuse the currently admitted source producer/adapter and registered tools. Scheduling is a small host policy, not a model-supplied route or capability claim. Unknown native capability or unsupported source stays unavailable. The admitted Native Pi and managed Matrix Pi tool sets have no native scheduler; they are distinct adapters. Matrix-managed Codex has no native scheduling contract here, but its real source qualification gate still applies. Ordinary Hermes keeps owner-profile tool discovery, so absence of an offered native scheduler is not established; its new Matrix proposals stay closed pending qualification. OpenCode native adaptation remains deferred and its production gate stays closed. Other still-unqualified native sources are not promoted by passing fixtures.

Claude's source must deny a new routine proposal before either engine has claimed work, even when an old client supplies `routineCreation:matrix`. Keep its native per-phase creation latch, due-phase isolation and irreversible no-alternate-engine behavior after cancellation/unknown. A legacy explicit Matrix intent must never silently become a native job.

The old optional request field, hash contribution, persisted contexts and proof verifier remain readable for historical identity. New clients omit the field. Existing accepted receipts/duplicate reconciliation/queued identity are not rewritten or replayed; a new obsolete override cannot create a Matrix task from Claude or change engine. No new Platform proof purpose/shared rollout is required for the ordinary no-field nonnative flow; exact source/action and canonical activation proofs remain enforced.

Tool/help guidance uses Nima's existing orientation and installed-tool description seams. Only expose a conversational routine instruction when that actual tool is present, explain pending approval, and preserve original UUID/revision on uncertainty. Do not implement Nima's capability-discovery or skill work again.

## First real nonnative acceptance

Use the existing `matrix_pi_chatgpt_plan` managed Chat route with the existing connected ChatGPT subscription. Its UI label is Codex / ChatGPT subscription; its actual driver is `matrix_pi`, not native Codex. Record both accurately. The host's real registered worker/generation, private broker, fixed published CLI, canonical task/approval and committed source result must be observed. No new native transport adapter or global background grant is justified by this test.

Acceptance requires a natural-language request with no route field/button, actual proposal, source-Chat review, a delayed result, pause across due times, future-only resume, duplicate/stale checks and CLI archive/history. Separately verify Claude native create/delayed same-Chat delivery/delete with no Matrix proposal. Existing failed/unknown histories remain unreplayed. Cancellation acknowledgement is not proof of process termination.

## Delivery and authorization

Independent stacked Draft PR with exact parent, English interface/validation explanation and a separate English site-doc update. Preserve original artifacts. Build/publish a separately named immutable QA bundle without channel promotion, deploy only to the already authorized Dev, verify installed/running/source provenance and health. No merge, fleet/shared deployment, production permission change, Slack, new paid resources/auth or deferred OpenCode adaptation. A newly necessary broader rollout or permission needs its own concrete authorization.

After matching-version real acceptance, refresh the English demonstration using the entire Chat viewport (sidebar/header/messages/composer), not cropped/reconstructed cards. Use real captures, disclose time compression and keep previous videos.
