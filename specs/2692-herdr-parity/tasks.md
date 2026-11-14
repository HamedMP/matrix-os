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

- [x] T2.1 Failing tests: named-key encoder (normal vs application cursor mode, ctrl/alt letters, unknown key rejected).
- [x] T2.2 Failing tests: `read` returns screen-only for `lines=0`, last N history lines, `incomplete` when no snapshot.
- [x] T2.3 Failing tests: `send` uses bracketed paste only when enabled, then Enter; refuses `blocked` without `force`; waits for draft quiet.
- [x] T2.4 Failing tests: `interrupt` sends Esc for status-reporting tabs, Ctrl+C otherwise.
- [x] T2.5 Implement `packages/gateway/src/terminal-agent/` (verbs, keys, input activity) over the runtime socket client.
- [x] T2.6 Routes in `terminal-agent/routes.ts`, wired in `server/shell-terminal-routes.ts`; viewer keystrokes recorded in `server/terminal-ws-routes.ts`.
- [x] T2.7 CLI `matrix shell read|send|keys|interrupt`; MCP tools.

## Layer 3: status, wait, events

- [x] T3.1 `matrix-status` reporter in `/opt/matrix/bin`; status files indexed by the terminal runtime and served as `ListAgentStatuses`.
- [x] T3.2 Hook events → Herdr words, written per pane by `matrix-agent-bridge`.
- [ ] T3.3 `matrix-osc-tap` pass-through for launched agents. Deferred to the follow-on stack: hooks cover Claude, Codex, OpenCode and Pi, and `matrix-status` covers scripts. Only programs that speak raw OSC 7501 still need the tap.
- [x] T3.4 `wait` (status/exit/output/timeout) with bounded waiters; CLI `matrix shell wait`; MCP `wait_terminal_tab`.
- [x] T3.5 `/ws/terminal/events` hub with snapshot, heartbeat, missed, sweep and shutdown drain; query-token allowlist.
- [x] T3.6 Exit sweep: tabs whose held pane reports an exit become `exited` with `exit_status` (found on the #3300 preview).

## Layer 4: agents

- [x] T4.1 Labels: set, remove, persisted per tab.
- [ ] T4.1b Filter `matrix shell list` and the events stream by label, as `hc ls --label`. Deferred: follow-up issue linked from #3298.
- [x] T4.2 Parent from the caller's pane (`ZELLIJ_SESSION_NAME` + `ZELLIJ_PANE_ID`, resolved by the runtime's `ResolvePane`); end-with-parent; `outliveParent`.
- [x] T4.3 Child notes to parent (`<matrix from=…>`).
- [x] T4.4 Templates from `~/agents/templates/`, first-message delivery, `firstMessage` persisted.
- [x] T4.5 `wait-children any|all`.
- [x] T4.6 Kernel IPC tools.
- [ ] T4.7 Keep-as-shell on loss. Deferred to the follow-on stack: it needs a terminal runtime change (zellij command panes) and its own spike.
- [x] T4.8 Calls from inside a terminal: `matrix` on the terminal PATH, local token, loopback route scope (found on the #3300 preview).
- [x] T4.9 Leading global flags stay ahead of `--` (found on the #3300 preview).

## Layer 5: attention UI

- [ ] T5.1 Shared derivation: roll-up, attention, agent order.
- [ ] T5.2 Web Desktop + Web Canvas: badges, agents list, pin, next/prev, toast + sound.
- [ ] T5.3 Electron Desktop main + Terminal windows on the same components.

## Layer 6: Electron local terminals

- [ ] T6.1 IPC: run with argv/cwd/name, label/rename, put, read, send, wait.
- [ ] T6.2 Renderer: `+` menu agents, folder picker, rename, paste, find.
