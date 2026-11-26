# Implementation plan

[Spec](spec.md) · [ENG-404](https://linear.app/matrix-os/issue/ENG-404/preserve-chat-effort-and-permission-when-switching-providers).

Two-layer native GitHub stack: #3596 supplies provider-native catalog/runtime modes
and shared labels; this mobile layer consumes them without duplicating policy.

1. Add failing persistence, first-use and native-label regressions.
2. Extend existing device preference entries with bounded per-instance choices,
   legacy migration and hydration preservation. Reuse serialized AsyncStorage saves.
3. Apply destination options/access in Chats and Project Chat. Preserve explicit
   models, active-chat controls, catalog binding validation and independent scopes.
4. Exercise real mobile picker/send boundaries, persisted reload and project route.
   Run Jest, native typecheck, React audit, patterns and relevant parity checks.
5. Publish a separate draft through gh stack submit and monitor Greptile to 5/5.
6. Obtain native dev-client live screenshots/recording and tech-channel evidence;
   coordinate the separate public-docs PR in FinnaAI/matrix-os-site content/docs.

Reuse DESIGN.md and current ModelSheet/Chip styles. No layout or motion redesign.
Evidence is kept outside Git; missing native runtime access blocks readiness.
