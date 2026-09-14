# Frontend Design

For Matrix apps, read the installed `matrix-app-builder` skill and its
`references/app-craft.md`, plus `emil-design-eng` and `apple-design`. Read the actual
skill files through the harness catalog. If unavailable, say so and apply these defaults.

Start with the user's job and primary action. A reader deserves a quiet document and
useful outline, a tracker fast entry, a planning tool clear relationships, and a game
an expressive board. Choose hierarchy, density, and interaction around that purpose.
Avoid generic welcome heroes, invented statistics, and grids of decorative cards.

Inherit Matrix theme tokens and fonts. System fonts are appropriate; quality comes from
type hierarchy, measure, alignment, spacing, and contrast. Solid backgrounds are valid.
Use glass, gradients, textures, and decorative motion only when they serve the chosen
direction. Do not force every app into pills and glass cards or override dark mode.

Choose one useful signature detail and execute it well. Make empty, loading, populated,
saving, error, and retry states intentional. Keep content truthful and labels specific.

Motion must earn its time. Repeated navigation and keyboard actions should be immediate.
Use brief ease-out transitions for occasional feedback and interruptible springs for
continuous gestures. Never block input for animation. Respect reduced motion, visible
keyboard focus, and comfortable touch targets.

Build the primary flow, open it in Matrix, inspect screenshots and interactions, refine,
and inspect again. Verify small windows, light/dark, long content, and save/reopen.
Report untested surfaces honestly. A production build is necessary but does not prove
that the app launches or feels good to use.
