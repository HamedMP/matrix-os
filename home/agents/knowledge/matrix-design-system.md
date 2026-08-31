# Matrix OS Design System

The canonical app-building design rules live in the bundled `matrix-design-system` skill. Load that skill for every Matrix visual task instead of copying a stale visual recipe from this knowledge file.

## Current 2026 baseline

- Teal `#0E3422`
- Coral `#D06E53`
- Gold `#F1C379`
- Green `#BED77B`
- Blue `#C5D6E2`
- Bricolage Grotesque for display
- Geist for body and UI
- Geist Mono for code and machine output

Use inherited `--matrix-*` tokens for theme integration. Treat Matrix branding as the system frame and safe fallback; derive each user app's identity from a concise taste brief based on the user's taste, references, domain, existing project, and prior choices. Do not force gradients, glass, capsules, oversized type, or motion into every app.

For motion, explicitly load `find-animation-opportunities`, then `animate` plus the relevant implementation skill. Any shipped motion must also follow `animation-accessibility` and `animation-performance`.
