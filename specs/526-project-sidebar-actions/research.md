# Research

- Decision: Extend canonical project registry with optional pinned. Rationale: it already owns project configuration and atomic serialization. Both registry validation and client projections need the field. Alternative rejected: renderer-only pin storage.
- Decision: Add metadata service using existing per-project lock and collaboration admission. Rationale: avoid races with archive/delete; preserve immutable identity/location. Alternative rejected: editing the whole project object from the renderer.
- Decision: Resolve the canonical project directory on the authenticated gateway and navigate the full Files app. Rationale: server validates the actual project directory, including imported folders; one bounded runtime-scoped navigation request opens or focuses Files. Alternative rejected: guessing owner-home prefixes or passing VPS paths to Finder.
- Decision: Reuse Radix dropdown/context menu primitives with one action array. Rationale: keyboard, focus and touch semantics without duplicating behavior.
- Confirmed requirement: Show in Files needs the existing runtime directory mapping, not a local Mac mapping. Native Mobile lacks project management navigation.
