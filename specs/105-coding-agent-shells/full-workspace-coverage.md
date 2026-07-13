# Full Workspace Coverage Matrix

**Status**: Planned evidence; no row is implementation proof

This matrix maps the Full Workspace backend delta to executable phases and named
acceptance evidence. The existing Phase 18-23 matrix remains in
`acceptance-tests.md`.

| Requirements | Primary tasks | Acceptance IDs |
| --- | --- | --- |
| FR-008, FR-009 | B24-002 through B24-010 | PL-101 through PL-104, PV-101 through PV-103, SC-024 |
| FR-010 through FR-016 | B24-011 through B24-014, B28-007 through B28-014 | CT-104, GW-112, GW-118, E2E-104, SEC-101, SC-026 |
| FR-090 through FR-094 | B25-001 through B26-007 | CT-101 through CT-103, DB-101 through DB-103, GW-101 through GW-103, SC-015 |
| FR-100 through FR-104 | B27-001 through B28-006 | GW-104 through GW-107, SC-016, SC-017 |
| FR-110 through FR-113 | B28-007 through B28-014 | GW-112, GW-118, SEC-101 |
| FR-120 through FR-125 | B29-001 through B29-008 | GW-108, GW-109, GW-117, E2E-102, SC-018, SC-019 |
| FR-130, FR-131 | B28-001 through B28-006 | GW-107, E2E-102, SC-020 |
| FR-132 through FR-134 | B30-001 through B30-006 | GW-110, GW-111, E2E-103, SC-021, SC-022 |
| FR-135 | B24-011 through B34-002 | CT-101, CT-102, CT-104, DB-101, GW-101 through GW-118, SEC-101 |
| FR-136 | B25-001 through B25-009 | DB-101 through DB-104, GW-116 |
| FR-137, FR-138 | B25-008, B25-010, B30-003 through B30-006, B31-008, B34-002 | GW-111, GW-116, SEC-101, SC-025 |
| FR-140 through FR-146 | B31-001 through B31-009, B32-001 through B32-006, UI34-007 through UI34-009 | GW-113 through GW-115, DT-101, MB-101, E2E-102 |
| US10 | B25-B26, UI34-002, UI34-005 | GW-101 through GW-103, DT-101, MB-101, E2E-101 |
| US11 | B27, B32, UI34 | GW-104, GW-105, E2E-102 |
| US12 | B28-007 through B28-014, B32, UI34 | GW-112, GW-118, E2E-104, SEC-101 |
| US13 | B28, B32, UI34 | GW-106, GW-107, SC-017 |
| US14 | B29, B32, UI34 | GW-108, GW-109, GW-117, SC-018, SC-019 |
| US15 | B28, B32, UI34 | GW-107, SC-020 |
| US16 | B30, B32, UI34 | GW-110, E2E-103, SC-021 |
| US17 | B25-008, B30, B31-008 | GW-111, GW-116, SC-022, SC-025 |
| Memory, automation, voice actions, policy, retention, recovery, diagnostics | B31-001 through B31-009, B32, UI34-008 through UI34-009 | GW-113 through GW-115, DT-101, MB-101, E2E-102 |
| Non-visual shell contract consumption | B32-001 through B32-006 | DT-101, MB-101, SEC-101 |
| Clean-room implementation boundary | B33-005 | SEC-102 |
| Shared preview acceptance | B33-001 through B33-005, B34-001 through B34-003 | E2E-101 through E2E-104, SEC-102, SC-023 through SC-026 |

## Gate Coverage

| Gate | Required evidence |
| --- | --- |
| B0 | Product owner confirms scope and non-goals. |
| B0.5 | PL-101 through PL-104, PV-101 through PV-103, CT-104, SC-024. |
| B1 | CT-101 through CT-103, DB-101 through DB-104, GW-116. |
| B2 | GW-101 through GW-103 and first flagged real-provider transcript smoke. |
| B3 | GW-104 through GW-107, GW-112, GW-118, and required real-process provider smokes. |
| B4 | GW-108, GW-109, GW-117. |
| B5 | GW-110, GW-111, GW-116. |
| B5.5 | Exact backend SHA/bundle/preview/fixture handoff plus SEC-102. |
| B6 | GW-113 through GW-115, GW-118, DT-101, MB-101, SEC-101, SEC-102, E2E-101 through E2E-104, SC-023 through SC-026. |

Every row requires current-head test output and cannot be marked implemented by
the existence of a schema, fixture, PR, preview, or documentation alone.
