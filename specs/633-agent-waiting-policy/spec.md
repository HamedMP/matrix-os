# ENG-344: bounded agent waiting and input parity

Ticket: https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload

The requester approved the lightweight T3-inspired design on 2026-10-21 (Asia/Shanghai). This first batch changes existing flows: human waiting and work-idle clocks, explicit run-timeout outcomes, and Native Mobile attachment preflight. It does not replace the harness architecture.

## Requirements

- Human approvals and input requests retain explicit canonical waiting events. For an adapter using the shared CLI inactivity clock, pending human input suspends that clock; accepting/expiring/cancelling the final pending request starts a fresh idle interval. Multiple pending requests must not resume the clock early.
- Absolute process deadlines, funded credential validity, funded inference and relay timeouts, worker lifetime and existing approval TTLs remain enforced. Waiting must never refresh or suspend those limits.
- Claude AskUserQuestion must retain a bounded human-wait lifetime when it no longer consumes the work-idle timer: use a separate 30-minute default human-input TTL, with bounded pending state and cleanup. Expiry cannot authorize a tool and cannot write an answer after cancellation.
- A managed Pi run reaching its existing 10-minute absolute deadline produces the existing reviewed execution_timeout failure, distinct from user Stop and subsystem shutdown. Preserve the first cancellation cause and make cleanup deterministic. Do not auto-retry possibly completed writes.
- Native Mobile validates the actual selected instance/model/options and attachments with the contracts' managed input policy before any upload or optimistic clearing. Cover ordinary chats and agent chats sharing the composer. Retrying a failed message must apply the current selection policy. Invalid files stay editable/removable and have a safe actionable error. Server admission remains authoritative.
- Keep upload counts, per-file/aggregate bytes, supported image types, funded image budget, all cost controls and output caps unchanged. Full-log archival, streaming backpressure, document extraction and durable draft redesign are separate follow-ups.

## Security and integration

No new endpoint, auth mode, database schema or permission grant. Existing personal owner/chat/run fences remain the source of authority. The shared contracts policy is pure and provides client hints only; gateway file revalidation and admission remain mandatory. Human waits are capped, resolved/closed state is removed, all new timers clear on terminal paths, and only reviewed error copy reaches clients.

Surface matrix: Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile receive the same existing canonical timeout/wait events; Native Mobile gains preflight parity with the already wired Web/Electron composers. No renderer-specific runtime policy.

## Acceptance and validation

TDD with fake clocks, fake child processes/workers and mocked upload transports; no real model calls, long waits, large-output stress, GUI/Electron launch, VPS, deployment, CI or external messages in this work. Preserve prior research execution restrictions except local code/dependency setup/tests/commits now authorized by the implementation request.

The checkout started at main 17a1ec7642 in a manual worktree. The main directory has unrelated uncommitted work and must not be edited. Parent .codex/.agents/Trellis configuration is not assumed inherited; implementers must read their task manifests and the parent instructions explicitly.

Live captures for all affected surfaces, a Native Mobile device check and the separate FinnaAI/matrix-os-site documentation PR remain release/review-readiness requirements. They cannot be claimed completed by unit tests and are not authorized by this local implementation task. Prepare public-safe behavior notes; no Slack send or PR/CI launch in this batch.

