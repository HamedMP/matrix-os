# ENG-457 evidence regressions

Ticket: https://linear.app/matrix-os/issue/ENG-457/herdr-parity-for-matrix-terminals-and-agents
Stack: https://github.com/HamedMP/matrix-os/stack/3301

1. Attention layer (#3299): render working/finished indicators in Canvas with the same status labels as Desktop. Extract the status dot from the large sidebar module rather than add inline branches.
2. Attention layer: distinguish attachment client loss from program exit. Keep the exact tab and incarnation on client loss; disconnect viewers so they can reattach. Only observer/held-pane evidence may mark the program ended. Extract client-loss handling from the large runtime module.
3. Desktop layer (#3300): route local file/image paste through existing validated local put IPC, preserving attachment identity during async work. Extract paste transport from the large TerminalView module.
4. Desktop layer: provision a private matrix-status reporter for local shells, bound status/message IPC, and show shared-copy attention notifications that update in place and open the existing local tab.

Validation: regression RED/GREEN tests at each producer/consumer boundary, affected type checks and React audit; actual preview pr-3300 (Web Desktop and Canvas) and native Electron on Preview Computer pr-3300 with This Computer terminals. Capture screenshots and 30–60 second recordings outside the repository, replace existing PR evidence comments and keep missing checks explicit. No merge.
