# Direct bot Chat acceptance

Tracking: ENG-49. This fixes admission and navigation within the existing bot specification.

## Required behavior

- Electron Desktop recipe creation opens the direct Chat returned by the server through the canonical Work tab.
- Web Canvas, Web Desktop, and Electron Desktop recognize the direct bot binding for the current Chat and runtime client. A stale lookup must not enable a different Chat.
- The direct bot composer displays Automatic and can send with an empty or unavailable ordinary provider catalog. The browser does not expose the hidden matrix_bot instance in the normal picker.
- Fresh and queued turns use the selection prepared by the server after owner and direct-bot checks. Retried turns use the persisted server-admitted selection. Bot admission must not read unrelated harness settings; concrete model readiness, owner grants, and funded admission remain enforced when the bot starts.
- Ordinary Chat catalog failures remain failures. Requesting matrix_bot from an ordinary Chat must be rejected before execution.
- Automatic routing can use the ready managed GLM access source without an Anthropic kernel instance. Source freshness, model eligibility, tool support, and funding remain required; a disabled source stays rejected.
- Failed sends preserve the draft and display the existing safe error. A successful admission alone is not proof of a completed Pi model run.

## Verification

Regression tests exercise real recipe navigation, shared composers, stale lookup cancellation, and gateway admission with a failed ordinary harness catalog. The direct-bot tests must also reject forged routing from an ordinary Chat.

Live acceptance must record the Electron renderer commit and exact Preview VPS bundle separately, then prove recipe creation, send, Pi response, a narrowly authorized tool, memory readback, and an ordinary Chat control case. Partial frontend success must not be reported as full Pi acceptance.

No new endpoint, permission, owner-data migration, or lock/transaction scope is introduced. Existing gateway principal resolution, owner repository reads, bot binding lookup, and bot adapter authority remain the security boundary. Public documentation has no changed workflow in this bug fix; the existing conversational-bot documentation remains applicable.
