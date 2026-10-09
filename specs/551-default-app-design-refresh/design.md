# Default app design review

This source refresh is a review candidate; it does not overwrite installed owner apps.

Notes uses a cool white writing surface, a narrow library rail and a centered serif document. Todo uses a restrained blue list with clear separators and a quiet capture field. Calculator uses a graphite readout above a large tactile keypad and a calculation tape. Clock uses oversized tabular time and visible analog dials. Weather uses the existing condition-driven sky and an airy forecast strip. Expenses uses a precise ledger and a prominent monthly spend. Task Manager keeps a delivery board, with quieter column surfaces and clearer card titles. Stickies preserves its spatial paper canvas. Game Center uses original vector-like game motifs with actual launch paths. Pomodoro is a single live clock with a small intent field. Profile and Social expose honest unavailable-data states rather than invented owner metrics.

Base tokens: porcelain #f6f8fc, ink #172033, slate #637084, divider #dae0e8, blue #315bb4, graphite #20262e. Native system typography serves navigation and amounts; Georgia serves only the Notes writing surface. Subject-specific structure, rather than palette substitutions, distinguishes these apps. Phone layouts use dynamic viewport height, safe area insets, readable inputs and accessible controls. OS-injected tokens remain authoritative.

No persistent schema or owner record changes. New Pomodoro countdown is explicitly session-only; it resets when this app closes. Profile/Social need their existing native feature surfaces wired before publication. Notification delivery and background execution are not claimed.

Behavioral changes have failing-first tests. Existing app/model tests and production builds verify preserved data flows. Rendered browser checks and actual Native Mobile cold/warm/save/reopen evidence remain pending authorized access. The prior denied gallery browser target is not accessed through alternate tools. Public design-review documentation is a companion deliverable owned by the parent.
