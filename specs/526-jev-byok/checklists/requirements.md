# Specification checklist: Jev Gateway + Personal API

Updated: 2026-09-21. [Spec](../spec.md).

- [x] Both sources are in scope; Gateway requires no personal TypeSafe key.
- [x] Gateway and personal inference charging are explicit and do not double debit.
- [x] Explicit source selection, immutable run binding and live revocation are specified.
- [x] No automatic cross-source fallback; primary-model fallback is distinguished.
- [x] Two-source readiness, testing, lifecycle, migration and error UX are defined.
- [x] Recipes are source-neutral and portable; private/billing authority never transfers.
- [x] Source/owner races, duplicate calls and unknown billing have acceptance criteria.
- [x] Ultrafast uses both sources through the common broker, with separate browser permissions.
- [x] Gateway availability remains a verified release gate, not an assumed shipped capability.
- [x] Frontend/backend plan, auth matrix, parity, documentation and real acceptance are aligned.

This checklist reviews the documents, not implementation or runtime results.
