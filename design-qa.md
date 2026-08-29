# Design QA: Desktop Chat workspace

- Final result: passed
- P0 findings: none
- P1 findings: none
- P2 findings: none
- Visual reference (only requested reference): `/var/folders/_w/0fk31pbd37zdj01yrzhd76140000gn/T/TemporaryItems/NSIRD_screencaptureui_g4ZeYs/Screenshot 2026-08-28 at 17.04.10.png`
- Combined reference/prototype input: `/Users/nighxxx/.codex/visualizations/2026/08/28/01a04622-3167-7bf2-9d7e-a255fd89439e/mat507-topbar-comparison.png`
- Maximized prototype capture: `/Users/nighxxx/.codex/visualizations/2026/08/28/01a04622-3167-7bf2-9d7e-a255fd89439e/mat507-maximized.png`
- Windowed prototype capture: `/Users/nighxxx/.codex/visualizations/2026/08/28/01a04622-3167-7bf2-9d7e-a255fd89439e/mat507-windowed.png`
- Runtime: authenticated local Desktop connected to the PR 1360 Preview computer

## Visual comparison

The combined input places the Codex reference above the Matrix implementation. The requested structure matches: a left pane control, a centered Chat title, and a right pane control occupy one dedicated top row in the maximized surface. Matrix keeps its own light appearance tokens and global Desktop chrome instead of copying Codex's dark theme or unrelated Share controls.

The windowed capture confirms the pane controls move into the same row as the traffic-light controls. The New chat action uses an inset divider and no full-width boxed treatment. The medium layout shows the canonical Chat panel beside the Inspector without overlap.

## Responsive and interaction QA

- Wide: navigation, canonical Chat, and Inspector render as three non-overlapping columns.
- Medium: a new Chat opens with the Inspector available and navigation collapsed; pane controls remain in the title row.
- Narrow: one labeled pane is visible at a time, with focus restored to the stable pane control.
- Navigation and Inspector dividers resize with pointer and keyboard input and collapse after crossing their minimum width.
- The file-list/preview divider resizes independently and reclamps when the outer Inspector shrinks, preserving a 240-pixel preview.
- Inspector tabs support multiple file previews and Chat-bound terminals. Closing a terminal tab ends its session before removing the tab.
- Radix portal actions no longer bubble into the Desktop background click handler, so adding a terminal does not minimize the Chat surface.
- Monaco uses the authoritative Matrix document theme; the verified light appearance rendered the `vs` editor with a light surface.
- Project routes stay on the canonical Chat surface and Board remains absent.
