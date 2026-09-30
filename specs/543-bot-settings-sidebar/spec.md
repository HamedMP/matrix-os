---
status: awaiting-device-validation
---
# Bot settings beside Chat

The existing bot permissions and memory block expands above the transcript, consumes conversation height, and uses internal terminology. Replace it with a quiet bot toolbar and a settings inspector beside the conversation.

## Requirements

- R1: Chat, its draft, pending questions, and scroll position survive opening, closing, switching settings sections, and bot status refreshes.
- R2: Settings overlay the right of a sufficiently wide Chat workspace without resizing the conversation or moving the opener. Wide panels support outside-click, trigger, and Escape dismissal. Narrow Web windows use an accessible overlay drawer; Native Mobile uses a separate modal sheet. Close and Escape return focus to the opener. Width follows the Chat window, not the screen.
- R3: Connections, Memory, and Routines have clear labels, counts, empty states, loading/retry states, and independently scrollable content. Connection names and access use shared human-readable derivation. Runtime details do not occupy the conversation toolbar.
- R4: Revoke, confirm, and forget use the existing authenticated, revisioned mutations. No optimistic deletion before success. Failed/stale reads show safe errors and disable mutation actions until a successful retry. An in-flight mutation cannot overwrite a different bot's settings.
- R5: Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile expose equivalent settings and actions. Shared web/Electron presentation owns layout and state; Native Mobile adapts platform chrome.

## Implementation units

- U1 Shared inspector (inline): shared copy helpers, focused tests first, compact toolbar, settings navigation, connection/memory/routine presentation, responsive focus management. Own `packages/contracts/src/bots/view-model.ts`, shared bot UI and CSS, `tests/ui/bots/` and contract view-model tests.
- U2 Chat wiring (inline, depends on U1): wrap Web/Electron transcript and composer in shared Chat inspector layout with only composition changes. Update existing parity/action tests and E2E labels. Preserve collaboration branches and existing file inspectors.
- U3 Native Mobile parity (delegated independent unit): own `apps/mobile/components/BotChatControls.tsx`, extracted native bot settings sheet, and `apps/mobile/__tests__/bot-transcript.test.tsx`. Tests first. Separate settings sheet, same Connections/Memory/Routines copy and actions, safe async failures, close on bot change. Do not change runtime requests.
- U4 Evidence/docs/review: test changed behavior, strict typechecks, builds, actual Web Canvas/Web Desktop/Electron captures through Cua with synthetic gateway data. Create a separate public-docs PR in FinnaAI/matrix-os-site. Independent code review before PR.

## Boundaries and invariants

No new endpoints, schemas, persistence, grants, model routes, org sharing, or OAuth behavior. Source of truth is existing owner-authenticated bot authority reads. Existing gateway transactions/revision checks remain the write authority. UI state is local and ephemeral. A successful mutation followed by a failed refresh keeps the last confirmed local change; stale server data must not re-enable a revoked grant. Settings never appear for shared/non-bot Chat. Native modal is the recorded platform layout adaptation.

## Acceptance

Test section switching, keyboard close/focus return, resize into drawer, failed authority reads/retry, mutation success/failure, draft persistence, non-bot and shared Chat isolation, and settings reset when Chat changes. Capture real renderers rather than mock HTML. Fixture screenshots demonstrate UI only; they do not qualify live Pi, Slack, or integrations.

Implementation and review UX fixes are complete. PR remains a draft pending real-device Native Mobile validation; see `docs/pr-evidence/543-bot-settings-sidebar/README.md` for the surface matrix and failed full native gates.
