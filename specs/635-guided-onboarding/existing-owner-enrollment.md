# Offer Get started once to owners with no active Matrix agents

Requested scope amendment, 2026-10-29. Related: [ENG-415](https://linear.app/matrix-os/issue/ENG-415/gate-the-get-started-wizard-for-new-users-with-a-posthog-flag), [ENG-366](https://linear.app/matrix-os/issue/ENG-366/guided-onboarding-get-started-wizard-and-personalized-first-run), and [rollout PR #2980](https://github.com/HamedMP/matrix-os/pull/2980). Those tickets originally excluded existing owners; the requester explicitly expands that cohort here and requested no new Linear ticket.

## Behavior

- Newly provisioned homes keep their seeded setup state.
- A missing `system/get-started.json` can become `pending` when the authenticated user is the primary runtime's configured owner and their canonical `ChatAgentStore.list(personalOwner)` is empty. Archived agents are excluded, as in the normal agent list. Built-in kernel agents and installed coding CLIs are not Matrix chat agents.
- Existing `pending` and `in_progress` state resumes even if the owner has since created an agent. Existing `completed` and `skipped` records always win, including after the last agent is archived or removed, refresh, another client, or gateway restart.
- A surviving `onboarding-complete.json` with `source: "get-started"` also prevents enrollment when the wizard state is missing. A legacy onboarding receipt alone does not prove this wizard was completed.
- Secondary runtimes, unauthenticated requests, and another user's principal cannot create eligibility. An unavailable/unreadable inventory fails closed with a generic 5xx; it does not mean zero agents. Existing saved state remains readable without consulting the inventory.

The empty-agent decision is a snapshot at initial enrollment. Creating an agent afterwards does not erase the setup draft or retract eligibility. Closing the client before finishing resumes the same setup; **Skip** or completion suppresses future offers. No browser-local receipt and no platform account database migration is introduced.

## Runtime wiring and concurrency

`server.ts` passes the already bootstrapped `ChatAgentStore`, configured runtime owner, and slot to the extracted `registerSettingsRoutes` composition module. Business rules stay in that module and the focused Get started route; the large server entrypoint gains dependency wiring only, following its existing extraction plan in spec 536.

The existing `GET /api/settings/get-started` lazily creates the owner configuration, like other owner settings reads. It uses the bounded owner-file mutation queue shared with PUT, a pinned no-follow system directory, capped reads, and exclusive atomic publication. The complete staged file is linked into place only while the destination is absent, so another gateway's saved state cannot be overwritten by enrollment. Temp files are explicitly removed after publication or errors. No database writes, schema changes, external calls, or new long-lived resources.

| Route | Authentication | Public | Bounds / writes |
| --- | --- | --- | --- |
| `GET /api/settings/get-started` | Existing gateway owner auth; enrollment additionally requires exact configured owner and primary slot | No | 8 KiB request body, 16 KiB state/receipt reads, canonical capped agent list; one exclusive state create |
| `PUT /api/settings/get-started` | Existing gateway owner auth | No | Existing 8 KiB body limit and strict update schema; unchanged completion/Skip transitions |

## Rollout

This is an independent backend companion to #2980. It adds eligibility, while that PR supplies the shared PostHog display gate `get-started-wizard` for Web Desktop, Web Canvas, and Electron Desktop. Do not claim merging this backend PR alone enables PostHog rollout.

1. Ship and validate both changes on the three desktop surfaces with the PostHog flag off. Older clients that predate #2980 ignore the PostHog flag; upgrade those clients before enabling their runtime.
2. The existing gateway opt-in remains `MATRIX_GET_STARTED_ENABLED=true`. Platform environment state and each existing VPS's `/opt/matrix/env/host.env` are separate: older provisioning may have written `false` explicitly even when the platform variable was unset. Review the intended existing-computer cohort, enable its runtime setting through the supported operator configuration path, and restart its gateway. Never overwrite an explicit kill switch automatically or reset owner setup files.
3. Enable `get-started-wizard` for the reviewed cohort. New owners and enrolled zero-agent owners are shown the same wizard; persisted terminal state suppresses it. Turning off the display flag preserves progress and receipts.
4. Public docs: a separate `FinnaAI/matrix-os-site` PR under `content/docs/` must explain eligibility, resume, and Skip. Recommend review by the onboarding/rollout owner for this expanded cohort.

## Verification and evidence

`tests/gateway/get-started-enrollment.test.ts` exercises registered Hono settings routes against the real file-backed `ChatAgentStore` and its test PGlite lock database: initial enrollment, active/archived/other-owner agents, restart, terminal suppression, resume, concurrent requests, kill switch, primary scope, missing dependencies, corrupt files, and symlinks. These are not browser or live-Postgres qualification. The exclusive atomic-write regression stages a pending record while a competing writer publishes a terminal receipt, then verifies the receipt wins and temp files are removed.

Regression red: seven enrollment assertions failed against the original code (`not_eligible`/404 instead of pending/progress and silent 200 on missing inventory); the competing-writer test also failed because rename overwrote its receipt. Green: run the focused suites and record the final command/result in the PR.

Live screenshots and a recording must cover Web Desktop, Web Canvas, and Electron Desktop on the exact final commit, with an existing zero-agent owner, resume, then Skip/complete and reload. Attach outside the repository. Native Mobile and Web Mobile do not mount this wizard; architectural N/A still needs reviewer approval. Missing per-surface captures and the corresponding Slack evidence remain release/readiness gaps, not passing checks.
