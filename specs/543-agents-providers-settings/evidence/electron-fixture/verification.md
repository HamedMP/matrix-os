# Electron Desktop workflow verification

Validated October 1, 2026 from the uncommitted `codex/agents-providers-figma` implementation worktree based on `951673cebf864669c346ae4a668ec8bb7b1d1ac6`. This is a source production Electron build, not an installed release or deployed VPS acceptance. The gateway, account state, codes, key responses, history, operation status and terminal process output are synthetic fixtures. No real provider credentials, remote provider authentication, payments, package installation or VPS calls were used.

## Build and tests

`flox activate -- bun run build:desktop` passed after the final shared UI changes and frozen dependency verification. The renderer transformed 10,381 modules. The actual launched app path was verified as this worktree's `desktop/out/main`.

```
MATRIX_DESKTOP_E2E_REQUIRED=1 flox activate -- pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 tests/e2e/desktop/agents-providers-figma.e2e.test.ts tests/e2e/desktop/provider-auth-terminal.e2e.test.ts
```

Final run at 18:23 local time: 2 files, 2 tests passed in 9.60 seconds. This build includes the final account-card, typed uncertainty, active-operation recovery and nonprimary history transport changes. Each app used a newly created temporary profile, deleted after the run. Owned app windows, gateway servers and sockets were closed. External browser opening was disabled for the synthetic flow.

Verified renderer interactions: four Coding agent rows and two General agent rows; paginated usage history; account/key chooser; device-code clipboard bytes and visible Copied state; closing and freshly reopening Settings with the same active operation recovered from capabilities and no duplicate login start; expiry and fresh retry; cancellation; masked key rejection and success; safe logs; disconnect cancellation without mutation and confirmed disconnect; initially unchecked managed-uninstall option; missing-agent expansion; named installation Terminal window; indeterminate progress; closing the Terminal window without completing the operation; cancellation through Settings. The legacy Claude login/logout flow also reopened the closed canonical Terminal and verified the recorded login command. The fixture's key rejection is HTTP 400 with typed `error.code: rejected`; neither history nor workflow schema validation was relaxed.

Build SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `desktop/out/main/index.js` | `43396dfa98f5bf501d39f9b90ea2174e178570aa5a756d6711a8c1b0bd26db2a` |
| `desktop/out/preload/index.cjs` | `327a49d279a2332b76051c512427b92753d162034e4c2e32560ce3cab6edd80f` |
| `desktop/out/renderer/assets/index-Dkw1X9OH.js` | `a2a3445533990747c2e4aa13a3d71d4f50bc89870f3b4efae547afee7bd41188` |
| `desktop/out/renderer/assets/index-Cot5N45H.css` | `4a2818f1ae31cab5954f8ad30b28a98f8e9f07da68bcb6e309c23d027f1d908a` |

## Visual evidence

Numbered PNGs are actual Electron screenshots. `01-overview-small.png` preserves the default 1280×820 renderer viewport. The native main window was then requested at 1500×1100; the monitor constrained it to 1500×949 (3000×1898 screenshot pixels). No product DOM styles were injected. `01-grouped-overview.png` uses real scrolling to show the six collapsed rows. `04-device-code-reopened.png` shows the recovered code after a fresh Settings open. `07-key-connected.png` shows Change account inside the authenticated card. `09-install-terminal-visible.png` establishes the visible Terminal; `09-install-indeterminate.png` captures Settings after closing that window while the operation remains running. Historical diagnostic PNGs were moved out of implementation/public evidence to the primary task's `research/electron-diagnostics/`.

Compared visually with the original task Figma context for overview, connected and chooser frames, and the computer-use observations for device code, expiry, keys, install and disconnect:

- Matrix AI has a contiguous credit/model card; agent groups, icons, disclosure rows, state chips and the selected-method checkmark follow the supplied structure. Masked errors, expiry/retry and centered disconnect confirmation are visible.
- The already-open Settings window retains its independent geometry when the native main window is resized; a fresh Settings window adapts to the new available size. Matrix AI and all six rows still do not fit together in the initial default overview viewport. Both groups are usable through scrolling. A taller Settings surface would be needed to reproduce the full overview frame in one viewport.
- The earlier card discrepancy is resolved: Change account appears once inside the authenticated account card. Unverified saved account details are collapsed, with the truthful Access not verified state left visible. Additional account/advanced disclosures still make this saved-account fixture state taller than the design's simple no-account chooser. No claim of pixel-perfect visual parity is made.
- Fixture usage is unknown for the owner key, and installation has no measured percentage or ETA. These remain unknown/indeterminate rather than copying design sample values. The synthetic ledger balance and model are fixture data, not hardcoded production values.

The E2E exposed an inventory-selection defect: missing agents could appear without being expandable through the controller's canonical installed-instance selection. The shared UI implementer fixed it with separate inventory expansion state and a failing-before/passing-after real-controller view regression. A later test navigation correction closed the foreground Terminal before interacting with Settings Cancel; no forced clicks or product workaround was used.

Real Preview runtime, real provider credentials/inference and human review remain separate acceptance gates owned by the main session.
