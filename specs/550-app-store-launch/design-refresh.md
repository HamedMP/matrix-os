# App design refresh for review

Goal: compare distinctive first-party and default Matrix app designs before release. Preserve owner data, permissions and current actions; fictional local previews are separate from installed owner apps.

## U1 Connected apps

Checkout: /private/tmp/matrix-connected-app-design-refresh, based on the current account-safety foundation.
Files: home/app-templates/connected-starter/src/** and focused tests/default-apps/connected-starter-design.test.tsx only.
Approach: replace shared dashboard composition with subject-specific views: Folio spending/receipt desk, Atlas destination canvas + selectable itinerary, Agenda time canvas, Subscriptions renewal rows, Focus full timer, Meeting Briefs readable documents, Projects board, Revenue precise trend/ledger. Keep owner Postgres, CAS, filtering, import/evidence and currency semantics. Existing smaller catalog apps inherit appropriate view designs. Local vectors may be clearly decorative; do not invent destinations, coordinates or photos from owner records. Mobile primary flows and all controls remain accessible.
Execution: behavioral tests first for new view selection/destination switching; characterize current data actions. Build production starter. No browser automation: gallery preview access was denied in the previous turn and alternate routes must not bypass it.
Verification: focused tests and existing starter tests, TypeScript, build; report remaining native/rendered evidence explicitly.

## U2 Default apps

Checkout: /private/tmp/matrix-default-app-design-refresh, based on origin/main.
Files: home/apps default source styling/components plus focused tests and a spec document. Do not edit connected-starter or gallery source.
Approach: refresh everyday apps (Notes, Todo, Task Manager, Calculator, Clock, Weather, Expense Tracker, Stickies, Pomodoro, Game Center/profile/social shared shell) with distinct visual structures. Preserve actual existing actions and records. Notes is an elegant writing surface, Todo a crisp task list, projects a delivery board, calculator an instrument, clock typographic dials, weather atmospheric conditions, expenses a precise ledger. Improve light/dark theme, phone targets/insets/text/overflow. Avoid recoloring every identical dashboard. Games keep board readability and existing mechanics.
Execution: keep pure visual changes separate from behavior; add meaningful failing tests before behavior changes. Existing tests and TypeScript builds verify preservation.
Verification: default-app focused tests and production builds; browser/native validation remains pending authorized access. No owner runtime writes.

## U3 Gallery and comparison

Checkout: /private/tmp/matrix-gallery-design-refresh, based on the reviewed search-test stack.
Files: design-prototype src/**, checks/**, public/demos generated packaging, default-demo compiled packaging, build/review documentation only.
Approach: retain premium minimal store, replace stale shared-starter cards with actual refreshed UI previews, add original/refreshed comparison and phone/desktop review of default apps. Load real compiled app source with fictional bounded adapters, no credentials or source imports. Keep opaque frame/CSP boundaries, show temporary example data and pending native validation truthfully. Do not fake screenshots; rendered capture requires authorized browser access.
Verification: helper/fixture tests, TypeScript and build, copied asset provenance digests, no owner capabilities. Actual browser checks must be reported pending when access remains denied.

## Coordination

Parallel implementation uses explicitly prepared independent checkouts with no intersecting owned files. The parent orchestrates integration, testing, commits and PRs. Each source refresh remains independently reviewable; comparison assets are copied only after source builds. Public documentation is a separate site PR. No release or owner app overwrite is included in the design review.
