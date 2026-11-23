# Native mobile approval parity

Ticket: [ENG-482](https://linear.app/matrix-os/issue/ENG-482/fixmobile-show-approval-requests-like-desktop)
PR: https://github.com/HamedMP/matrix-os/pull/3378

Native mobile uses one approval presentation for Claude tools, Codex and other
canonical approvals, browser permissions, and routine confirmations. The card
shows a waiting status, complete wrapping title, explanation, optional expandable
request details, and shared library buttons. Longer choices stack to remain readable.
Recorded outcomes remove the waiting status and controls. Browser grant scope and
Undo, and routine operation details remain visible.

This is a renderer change. Existing authenticated clients, run/approval IDs,
action digests, retry IDs, allowed decisions, browser grant scopes, expiry, and
routine authorization stay authoritative. Never infer unsupported decisions or
reconstruct withheld tool inputs. Structured details display only the already
projected description. Known Claude copy remains supplied by contracts.

Validation: regressions first for provider-independent cards, exact decision
requests, expired/recorded states, browser Undo and routine state; full mobile
suite; real Codex approval on the signed-in simulator and persisted result.
Other approval types require clearly labeled renderer captures on native mobile.
Captures stay outside the repository and are attached to the PR only, per the
requester. Recommend Chat/design owner review of the expanded presentation.

Documentation follow-up: separate FinnaAI/matrix-os-site content/docs PR describing
the native approval choices and provider parity; no public documentation source
is maintained in this repository.
