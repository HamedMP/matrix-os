# Electron reconnect and practical browser workflows

Status: implemented and validated on the scoped preview, 2026-10-13. Delivery remains in PR review; shared Chrome attachment for Chat harnesses is separate follow-up scope.

## R1 — Recover an expired native browser session
- Goal: Reconnect Browser and Cloud desktop after the ten-minute owner app cookie expires without restarting Chrome or widening app admission.
- Files: desktop/src/main/embeds/browser-product-session.ts, native-app-bridge.ts, packages/ui/src/browser/hosted-session.ts and focused tests; gateway app-session route only if evidence requires it.
- Approach: reproduce the real renewal response and bridge path; preserve exact trusted owner/route/cookie scope, lifetime and auth-generation guards; fix the narrow broken boundary.
- Execution note: failing regression first, then implement.
- Test scenarios: actual production-format response, expired reconnect, scoped cookie, auth change during renewal, failure/retry and concurrent product views.
- Verification: focused tests, relevant typecheck/build, isolated packaged Electron live reconnect beyond expiry with same Chrome process.

## R2 — Review browser tools and curate work skills
- Goal: identify reusable patterns from official OpenClaw, Hermes, agent-browser and Browser Use sources for admin, accounting preparation and information collection.
- Files: specs/627-browser-vps-comparison/workflow-research.md; proposed original Matrix skill content follows repository skill loader conventions after review.
- Approach: primary sources with version/date and license attribution; document current capability honestly, select a small useful skill set and avoid blind installation or claims that Chat already controls the shared headed Chrome.
- Execution note: documentation research; no executable third-party install.
- Test scenarios: tool compatibility, owner authentication/takeover boundaries, downloaded document provenance, repeat runs and approval before submissions.
- Verification: source links support claims, actionable skills fit Matrix's actual tool vocabulary; added skills load through the real parser.

## R3 — Verify, publish evidence and documentation
- Goal: finish the scoped Web Canvas, Web Desktop and Electron Desktop checks and update actual Figma evidence plus both existing PRs.
- Files: specs/627-browser-vps-comparison/results.md, chrome-first.md; Figma Browser board; site-repository browser-automation.mdx.
- Approach: only the disposable test VPS and isolated test desktop package; use public pages or synthetic data, confirm expiry/reconnect and retain Chrome profile.
- Execution note: current live evidence supersedes earlier preliminary notes.
- Test scenarios: launch/input, Matrix and Linux minimize/restore, exclusive views, reconnect after expiration, Files/Terminal and unavailable/retry states.
- Verification: accurate evidence, clean reviewed commits and public documentation; no primary runtime, channel, installed desktop or fleet changes.

Parallel safety: R1 code and R2 research document do not overlap. R3 follows their results. The orchestrator owns tests, staging and commits in this existing manual worktree.

## Completion evidence

- R1: two real gateway-format regressions failed before the narrow cookie fix and passed after it. The isolated Electron package disconnected after actual ten-minute expiry and Reconnect restored the same Chrome session. The renewed cookie retained Secure, HttpOnly and Strict attributes. Chrome service process and all eight core/browser services remained healthy.
- R2: three original Matrix preparation skills passed the real loader/mirror checks and were installed without overwriting owner files on the disposable test VPS. The owner-authenticated skills catalog returned all three enabled. Independent synthetic accounting evaluation preserved duplicate/conflicting evidence and incomplete coverage, distinguished exports from originals, and ignored embedded payment instructions.
- R3: actual Web Canvas, Web Desktop and packaged Electron journeys passed; Figma has 19 new actual screenshots, with the long-session before/after pair. Public documentation and both PRs describe current limitations. The installed desktop app and fleet were not changed.
