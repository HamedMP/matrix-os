# Research

- Decision: Extend canonical project registry with optional pinned. Rationale: it already owns project configuration and atomic serialization. Both registry validation and client projections need the field. Alternative rejected: renderer-only pin storage.
- Decision: Add metadata service using existing per-project lock and collaboration admission. Rationale: avoid races with archive/delete; preserve immutable identity/location. Alternative rejected: editing the whole project object from the renderer.
- Decision: Reuse project-scoped InspectorFilesPanel in a Files dialog. Rationale: server resolves runtime root; existing browser adapter supports web and Electron. Alternative rejected: guessing owner-home prefixes or passing VPS paths to Finder.
- Decision: Reuse Radix dropdown/context menu primitives with one action array. Rationale: keyboard, focus and touch semantics without duplicating behavior.
- Limitation: Finder requires a trusted local mapping absent from the current product; Native Mobile lacks project management navigation.
