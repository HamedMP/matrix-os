# Mobile provider-specific Chat defaults

Ticket: [ENG-404](https://linear.app/matrix-os/issue/ENG-404/preserve-chat-effort-and-permission-when-switching-providers).
Depends on [#3596](https://github.com/HamedMP/matrix-os/pull/3596).
Implementation: [plan](plan.md).

## User outcome

Native Mobile remembers model options and permission choices separately for each
provider instance, within the existing signed-in account/computer/runtime scope.
Chats and Project Chat restore destination effort/access on A → B → A. Explicit
model picks win over a remembered model; new Chats and app restarts retain defaults.
A first-use provider uses its catalog defaults, without another provider's access.

## Controls and authority

Reuse ModelPicker, ModelSheet, ChoiceSection, Chip and theme.v2 tokens. Keep the
current sheet layout, focus/selection semantics and motion. Permission names use
the shared provider-aware helper: Codex Ask for approval / Approve for me / Full
Access; Claude Manual / Accept edits / Auto / Don't ask / Full Access. Effort comes
from the provider catalog, including Claude Extra high and Max when supported.
No copied capability lists or additional provider API calls.

Picker mutations wait for preference hydration on both routes. Existing open Chats
can still send using their known saved controls while preferences load.
Existing open Chats retain their saved controls until the user changes them.
Changing a default never mutates a running turn. Explicit provider switches reset
local permission overrides to the destination's supported saved mode or default.
Model options restore only catalog-valid composer options; current account-binding
options come from the catalog rather than saved credentials or stale grants.

## Persistence and compatibility

Extend the existing AsyncStorage preference configuration; this is device config,
not app records. Keep at most eight owner/computer scopes and twenty provider rows
per scope. Read the legacy single choice as belonging only to its selected instance.
Serialize writes, preserve independent providers during hydration, and notify all
mounted readers through the existing external store. Sign-out forgetting and scope
isolation remain authoritative. Do not add database writes or another storage engine.

## Acceptance

- Real picker round trip preserves distinct effort/access and explicit model picks;
  next-message arguments match the choices shown. Project Chat follows the same rule.
- Persist/reload restores independent choices; legacy and first-use defaults do not
  grant cross-provider access. Unsupported values use catalog validation/fallback.
- Subscription account replacements preserve current catalog binding authority.
- Tests demonstrate production-boundary regression red/green. Run native Jest,
  typecheck, React audit, pattern checks and relevant shell/gateway parity suites.
- Qualify Native Mobile with screenshots and a short recording from a dev client or
  equivalent native build against a reviewed runtime. Web Mobile evidence belongs
  to #3596; it cannot substitute for Native Mobile. Attach evidence to both the PR
  and the required tech-channel post before review-readiness.
- Public documentation is a separate PR in FinnaAI/matrix-os-site content/docs,
  coordinated with #3596. Recommend product/engineering review of access semantics.

## Boundaries

No new endpoints: existing authenticated owner catalog/admission routes enforce
capabilities. No new secrets, locks, transactions or orphan states. Other OS views
have no code changes in this layer. No production deployment or merge is authorized.
