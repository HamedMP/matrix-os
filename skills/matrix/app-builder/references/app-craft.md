# App craft: design for the job

Matrix ships the owner-provided `emil-design-eng`, `apple-design`, `animate`, and
motion-support skill snapshots with attribution in each `PROVENANCE.md`. Select by
task: design polish → `emil-design-eng`; gestures/spatial motion → `apple-design`;
specific transition → `animate`; reduced motion → `animation-accessibility`;
dropped frames → `animation-performance`; final motion pass → `review-animations`.
Read only the relevant skill bodies and recipe resources. Discover skills through
the active harness's catalog first; read the actual SKILL.md, not just its description.
Common roots are `$MATRIX_HOME/.agents/skills`, `$MATRIX_HOME/agents/skills`,
`$MATRIX_HOME/.claude/skills`, `$MATRIX_HOME/.codex/skills`, `$HOME/.agents/skills`,
`$HOME/.claude/skills`, and `$HERMES_HOME/skills` when set.
If absent, say so and use the guidance below; never claim you loaded a missing skill.
Matrix's runtime, theme, security, and accessibility requirements still apply.

## Before coding

Write a short design direction in the app `DESIGN.md`: who uses this, their primary action,
the content that deserves the most space, the appropriate density, and one detail
that makes this particular app useful and memorable. Choose sensible defaults without
turning this into a questionnaire. Follow user-provided references and existing app style.
Offer two or three reference-based directions only when the user asks or a materially
ambiguous direction would benefit from comparison; continue with the best-fitting
choice without waiting for design approval. Do not add a new preview editor.

A concise direction can be six lines:

```text
Primary task: log and revise daily entries in one short flow.
Layout/density: entry composer above a compact chronological list; detail inline.
Tokens/type: Matrix inherited background/card/text/accent; shell sans/mono fonts; 4/8/12/16/24 spacing.
Data: entries(title text, done boolean, created_at timestamptz) in owner's Postgres through MatrixOS.db.
States: loading skeleton, honest empty/create CTA, saving indicator, retryable error, populated list.
Motion: pointer press 120ms, occasional detail opacity 160ms; keyboard navigation immediate; reduced motion static.
```

The choices should reflect the actual app and references; do not paste this tracker
layout into readers, games, creative tools, or every business dashboard.

Choose the structure from the work: a reader gives the document comfortable measure
and a quiet outline; a tracker gives entries and rapid logging priority; a planning app
makes time or relationships visible; a game centers the board and immediate feedback.
A dashboard is justified only when its overview helps a real decision.

## Complete a real data slice

Declare persisted fields in `matrix.json` and build one working interaction before
secondary screens. Use only the injected `window.MatrixOS.db` bridge; Matrix owns
authentication and the owner/app Postgres scope. In a tracker, first read entries
with a bounded `find`, insert a real entry, edit it with `update`, and reopen the
app to verify that it survives. Reconcile returned IDs and `onChange` notifications;
dispose the subscription on unmount. Test empty/loading/populated/error/saving states.
A missing bridge is a visible unavailable-data state with retry, not a successful
in-memory fallback. Do not seed sample records on every launch.

For an edit, keep the previous record and unsaved draft, mark only that record as
pending, and disable duplicate submission until its write settles. Confirm the new
value on success. On failure, restore the affected optimistic value, retain the
draft for retry, log details privately, and show a short generic message. For a
confirmed delete, then remove the record; for an optimistic delete, restore it on
failure. Serialize same-record edits or use mutation identities so an older
failure cannot erase a newer edit. Never replace the entire list with a stale
snapshot to roll back one action.

Use a single targeted write for one entity. If the operation needs several related
DB changes, use an existing documented atomic bulk/server operation or redesign to
one write; sequential bridge requests are not a transaction. Do not advertise a
transaction method the bridge does not expose, or add a new embedded database.

## Visual decisions

- Use inherited Matrix fonts and tokens. Establish hierarchy through size, weight,
  leading, alignment, and spacing; system fonts are a good default. Use tabular figures
  where numbers need comparison and comfortable line lengths for reading.
- Favor a clear content surface. Use cards for distinct objects, not as wrappers around
  every heading. Group related controls near the content they affect. Avoid duplicate
  app/window titles, oversized welcome banners, decorative metrics, and generic hero copy.
- Make empty states truthful: one useful next action, no fake records, invented usage,
  fake avatars, or testimonials. Example content must be clearly labeled and removable.
- Keep color purposeful: selection, action, status. Theme-aware solid surfaces are valid.
  Glass or a gradient must explain depth or fit the requested art direction; do not apply
  a sand wash, glow, mesh, or blur to every app. Avoid nested glass panels.
- Use a small spacing and radius scale. Compact rectangular controls suit dense tools;
  pills suit tags or segmented choices. Choose per function, not one radius for everything.
- Give the app one useful signature detail: an excellent reading outline, direct board
  manipulation, an expressive progress view, or fast inline editing. Decoration is optional.

## Motion decisions

First ask whether motion helps this action and how often it happens. Keep typing,
keyboard shortcuts, filtering, and repeated list navigation immediate. Do not stagger
the whole app on mount or replay an entrance when changing tabs or refreshing data.

For occasional state changes, use short, purposeful motion: press feedback around
100–160ms, popovers around 125–200ms, most transitions under 300ms. Use ease-out for
entry/exit, such as `cubic-bezier(0.23, 1, 0.32, 1)`, and ease-in-out for movement between
positions. Specify properties; avoid `transition: all`. Prefer transform and opacity.
Anchor popovers to their trigger; keep modals centered. Start subtle scale entrances
near 0.97 rather than zero. Reserve bounce for interactions whose momentum warrants it.

Show press feedback immediately but commit actions on click/release, preserving cancel
and keyboard behavior. Gate hover effects behind `(hover: hover) and (pointer: fine)`.
Use CSS transitions for simple state changes. For drag/swipe, track the pointer directly
and use interruptible springs that retain velocity on release; never lock input while
motion finishes. Reuse an existing accessible component library when appropriate.

Honor `prefers-reduced-motion`: static changes or brief opacity feedback, no slides,
parallax, or spring overshoot. If using translucency, support reduced transparency and
increased contrast. Never hide information or delay an action to finish an animation.

## Motion recipe: tracker details and primary action

For a dense tracker, row selection and keyboard movement are immediate. A native
button submits on click (also Enter/Space); pointer-down gets press feedback only.
An occasional detail panel may fade over 160ms; opening/focus does not await it.
Escape closes the detail and restores focus to its trigger. A cancel action must
not trigger a subsequent blur-save. Keep focus visible and announce pending/save
outcomes with a polite live region; never hide errors behind a disappearing toast.

```css
.action {
  background: var(--matrix-primary);
  color: var(--matrix-primary-fg);
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}
.action:active { transform: scale(0.97); }
.action:focus-visible { outline: 2px solid var(--matrix-accent); outline-offset: 3px; }
.detail { opacity: 0; transition: opacity 160ms ease-out; }
.detail[data-open="true"] { opacity: 1; }
@media (hover: hover) and (pointer: fine) {
  .action:hover { filter: brightness(1.05); }
}
@media (prefers-reduced-motion: reduce) {
  .action, .detail { transition: none; }
  .action:active { transform: none; }
}
```

Use an accessible dialog/sheet primitive when a detail is modal: move focus into
it, trap focus while open, make background content inert, and restore focus on
close. Hidden panels must leave the tab order/accessibility tree; opacity alone
is not hiding. Apply the recipe only to occasional transitions; repeated keyboard
navigation and successful data updates should remain immediate. Test interrupted
open/close and failures with normal and reduced motion.

## Inspect and refine

Run the app in Matrix, not only a standalone preview. Check Web Canvas, Web Desktop,
and Electron Desktop where available; include Web Mobile and Native Mobile when supported.
At minimum inspect a narrow window, the normal working size, both theme modes, and
reduced motion. Test keyboard focus, Escape, labeled icon buttons, long text, empty,
loading, failure/retry, populated, and saving states. Touch targets should be comfortably
usable (aim for 44px on touch surfaces). Verify persistence by reopening the app.

Capture screenshots and interact with the primary flow; review motion at normal speed
and slower playback when tools allow. Fix the biggest hierarchy, spacing, contrast, or
interaction problems, then inspect again. Report what you actually tested and any
unavailable surface. A successful build alone is not visual or launch verification.


## Reference continuity

Use [Visual references and style intake](visual-references.md) to inspect actual app screenshots, invite the user's preferred style, and delegate bounded reference research when available. Record the selected direction, component/token decisions and interaction states in DESIGN.md. Refine from actual Matrix screenshots while preserving the user's intent. References inform original product-specific work; build and persistence checks establish whether the implementation works.
