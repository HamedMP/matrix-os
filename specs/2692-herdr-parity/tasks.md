# Tasks: Herdr Parity

## GitHub Stack Plan

One native stack, 6 layers, base `main`. Each layer stays under 1000 additions
where possible (hard limit 3000 additions / 50 files).

| Layer | Branch | Title |
|---|---|---|
| 1 | `feat/herdr-parity-spec` | docs(terminal): specify Herdr parity |
| 2 | `feat/herdr-parity-verbs` | feat(terminal): add read, send, keys and interrupt verbs |
| 3 | `feat/herdr-parity-status` | feat(terminal): report agent status, wait and stream events |
| 4 | `feat/herdr-parity-agents` | feat(terminal): add parent agents, templates and labels |
| 5 | `feat/herdr-parity-attention` | feat(shell): show agent attention across OS views |
| 6 | `feat/herdr-parity-desktop` | feat(desktop): bring local terminals to parity |

## Public documentation (separate PR in `FinnaAI/matrix-os-site`)

- [ ] D1 `content/docs/`: document the terminal agent commands (`matrix shell run|get|read|send|keys|interrupt|wait|wait-children|label|report|templates`), `matrix-status`, the template format (`~/agents/templates/<name>.md`), the MCP terminal tools, and their limits: 8 KiB sends, 90 s per wait request, 256-character output matches, owner terminals only. Open it once this stack's interfaces are reviewed, before the stack merges.

## Layer 2: verbs

- [ ] T2.1 Failing tests: named-key encoder (normal vs application cursor mode, ctrl/alt letters, unknown key rejected).
- [ ] T2.2 Failing tests: `read` returns screen-only for `lines=0`, last N history lines, `incomplete` when no snapshot.
- [ ] T2.3 Failing tests: `send` uses bracketed paste only when enabled, then Enter; refuses `blocked` without `force`; waits for draft quiet.
- [ ] T2.4 Failing tests: `interrupt` sends Esc for status-reporting tabs, Ctrl+C otherwise.
- [ ] T2.5 Implement `packages/terminal-runtime/src/agent-verbs/`.
- [ ] T2.6 Routes in `workspace-routes.ts` (extract to `agent-verb-routes.ts` to stay < 500 LOC), wired in `server/shell-terminal-routes.ts`.
- [ ] T2.7 CLI `matrix shell read|send|keys|interrupt`; MCP tools.

## Layer 3: status, wait, events

- [ ] T3.1 `matrix-status` reporter in terminal PATH bootstrap; status file schema + watcher.
- [ ] T3.2 Hook phase → Herdr word mapping per tab.
- [ ] T3.3 `matrix-osc-tap` pass-through for launched agents.
- [ ] T3.4 `wait` (status/exit/output/timeout) with bounded waiters.
- [ ] T3.5 `/ws/terminal/events` hub with snapshot, heartbeat, missed, sweep and shutdown drain; query-token allowlist.

## Layer 4: agents

- [ ] T4.1 Labels + list filter.
- [ ] T4.2 `MATRIX_TERMINAL_REF` per pane; `parentRef`, cascade end, `outliveParent`.
- [ ] T4.3 Child notes to parent (`<matrix from=…>`).
- [ ] T4.4 Templates from `~/agents/templates/`, first-message delivery, `firstMessage` persisted.
- [ ] T4.5 `wait-children any|all`.
- [ ] T4.6 Kernel IPC tools.
- [ ] T4.7 Keep-as-shell on loss.

## Layer 5: attention UI

- [ ] T5.1 Shared derivation: roll-up, attention, agent order.
- [ ] T5.2 Web Desktop + Web Canvas: badges, agents list, pin, next/prev, toast + sound.
- [ ] T5.3 Electron Desktop main + Terminal windows on the same components.

## Layer 6: Electron local terminals

- [ ] T6.1 IPC: run with argv/cwd/name, label/rename, put, read, send, wait.
- [ ] T6.2 Renderer: `+` menu agents, folder picker, rename, paste, find.
