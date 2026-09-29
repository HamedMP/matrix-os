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

## Owner Codex subscription route

Trusted Preview host configuration may set `MATRIX_BOT_CODEX_MODEL` to a concrete GPT model. When configured, bots use Pi's OpenAI Responses provider through the existing loopback bridge and the owner's native Codex OAuth identity (`.codex/auth.json`). This route rejects API-key identities and does not fall back to Matrix credit or Anthropic. The gateway shares the existing bounded OAuth reader/refresh resolver; no token enters the worker, renderer, persisted model route, or logs. Existing owner, bot, runtime generation, exact model and tool authority checks remain required before each upstream send, including after credential refresh. Subscription calls use only the fixed ChatGPT Codex endpoint, bounded response/body handling, redirect rejection and a 30-second inference deadline.

Pi Responses input is normalized for the subscription API (system instructions, store=false, removal of unsupported output/cache controls), preserving tools and user input. Credentials remain independent from Pi's CLI installation. Tests must cover subscription-only identity, revoked authority, stale generation, exact model matching, and one bounded refresh after 401. Live evidence must identify the installed bundle and actual owner login; unit tests or local token presence do not prove a completed subscription request.
