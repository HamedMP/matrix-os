# App craft: design for the job

Use this alongside the installed `emil-design-eng` and `apple-design` skills from
https://github.com/emilkowalski/skills. Read `animate` for a specific motion task and
`review-animations` when available for the final motion pass. Discover skills through
the active harness's catalog first; read the actual SKILL.md, not just its description.
Common roots are `$MATRIX_HOME/.agents/skills`, `$MATRIX_HOME/agents/skills`,
`$MATRIX_HOME/.claude/skills`, `$MATRIX_HOME/.codex/skills`, `$HOME/.agents/skills`,
`$HOME/.claude/skills`, and `$HERMES_HOME/skills` when set.
If absent, say so and use the guidance below; never claim you loaded a missing skill.
Matrix's runtime, theme, security, and accessibility requirements still apply.

## Before coding

Write a short design direction in the task notes: who uses this, their primary action,
the content that deserves the most space, the appropriate density, and one detail
that makes this particular app useful and memorable. Choose sensible defaults without
turning this into a questionnaire. Follow user-provided references and existing app style.

Choose the structure from the work: a reader gives the document comfortable measure
and a quiet outline; a tracker gives entries and rapid logging priority; a planning app
makes time or relationships visible; a game centers the board and immediate feedback.
A dashboard is justified only when its overview helps a real decision.

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
