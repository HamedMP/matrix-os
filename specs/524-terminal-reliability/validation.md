# Execution evidence — 2026-09-17

## First repair candidate

PR #1736, commit `d4f20f8f6817fed902c684ea4abe9d7bac7daa50`. Account-owned Preview `pr-1736` runs `v2026.09.17-pr1736-35234533010-1-d4f20f8`; installed/running version and release SHA match. The shared-default-owner workflow was cancelled after deployment, and only its newly created disposable VPS was replaced through the supported platform API so the reviewer retains owner-only Terminal access. No production promotion or global auth change occurred.

- 13 new unit/Unix socket regressions pass; repo and runtime type checks, pattern scan, Electron production build pass.
- Full macOS suite: 15,726 pass, 30 fail, 44 skipped. All 30 failing test names reproduce on untouched de815be50. This is not a green full suite.
- Actual baseline Electron startup emitted 259 protocol replies. Baseline live probes closed at 33 and 259 individual frames; the fixed Preview stays open at 32, 33, 259, 33 and 259, answers ping, and executes subsequent commands.
- Fixed Electron startup emitted 259 replies with no WebSocket close/error over 24 seconds.
- Live observer/writer/revoked-writer/takeover cases pass. Normal and zero-delay keyboard tracing delivers the complete input and expected result on an attached terminal.
- Final 10 consecutive fresh-terminal trials, waiting for actual attached state before interaction, each opened one new connection, obtained writer authority, and produced its unique result exactly once, with no connection-status warning. Intentional closure of the previous tab's viewer is excluded from reconnect counts.
- Gateway and runtime service checks during validation reported zero restarts and no relevant overflow/attach failure logs.

## Remaining evidence gaps

An earlier repeated-opening pass observed one socket close/reopen before the first attached frame, after which input succeeded. Its cause is not established; final trials did not reproduce it. Retain this as an open lifecycle observation, distinct from the verified input-burst overflow. Earlier fixed-delay automation also attempted input before readiness and interacted unreliably with xterm's helper textarea; those interrupted trials are not counted as passing.

The complete matrix in quickstart.md remains pending beyond the bounded checks above. Web/Canvas/mobile parity, long-duration reconnects, old processes across two upgrades, replay/snapshot restoration and all everyday interactions have not been established by this repair. Human Review and exact-head landing gates remain open. This document is evidence for a candidate, not a declaration of complete Terminal reliability.
