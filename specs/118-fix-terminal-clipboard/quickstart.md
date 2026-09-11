# Quickstart: Implement and Verify Terminal Clipboard Reliability

Run all commands from the manual feature worktree:

```bash
cd /home/nima/matrix-os/.worktrees/fix-terminal-clipboard-selection
```

## 1. Establish red tests

Write the failing tests before production changes, in this order:

1. Shared shortcut and pointer policy.
2. Native Desktop key, right-click ordering, passive mouse, failure, and pane-focus behavior.
3. Web terminal parity and Canvas zoom behavior.
4. Real packaged Electron clipboard journey.

Run focused tests as each layer is added:

```bash
bun run test -- tests/contracts/terminal-clipboard.test.ts
bun run test -- tests/desktop/terminal-view.test.tsx tests/desktop/terminal-link-actions.test.ts tests/desktop/terminal-link-context-menu.test.tsx
bun run test -- tests/shell/terminal-pane-clipboard.test.tsx tests/shell/terminal-pane-zoom-correction.test.ts tests/shell/terminal-link-context-menu.test.tsx
```

The fake xterm must install its mutation listener on an inner `.xterm` element and run it before the host bubble listener; dispatching `contextmenu` directly on the host does not reproduce the bug.

## 2. Implement in ownership order

1. Add the pure `@matrix-os/contracts` classifier/protection policy and export it through the package-local import map.
2. Update native `TerminalView` and its menu/actions, including explicit image/text paste routing and operation generation guards.
3. Update web `TerminalPane` and generalize its link menu to terminal actions while preserving optional link commands.
4. Update CI so the new Electron E2E runs after the desktop build and cannot silently skip.

Keep xterm selection authoritative. Do not use DOM selection, copy selected text into global state, rebuild xterm ranges, or clear selection after Copy.

## 3. Automated verification

Run targeted tests first, then the required repository gates:

```bash
bun run typecheck
bun run check:patterns
bun run test
npx react-doctor@latest desktop
npx react-doctor@latest shell
```

Build the Electron app before the new Playwright test, then execute it through the repository E2E configuration:

```bash
bun run build:desktop
bun run test:e2e -- tests/e2e/desktop/terminal-clipboard.e2e.test.ts
```

The E2E test must use Electron's native clipboard, real xterm, deterministic multiline/wrapped/Unicode output, and a mouse-aware SGR session. It must prove:

- Command+C and Command+Shift+C copy the exact selection;
- Command+V writes once and does not append Enter;
- right-click Copy keeps the entire range and stays enabled;
- Select All survives at least ten seconds of passive movement;
- TUI mouse reporting resumes after selection clears;
- two terminals cannot consume each other's selection or paste result.

## 4. Manual acceptance matrix

Use synthetic, non-sensitive terminal output. Repeat the full copy/paste/right-click/Select All journey in:

- native Electron Desktop mode on macOS;
- native Electron Canvas at zoom 0.5, 1, and 2;
- Web Canvas at zoom 0.25, 0.5, 1, fitted zoom, 1.5, and 3;
- Web Desktop;
- a plain shell and Codex or another SGR mouse-aware TUI;
- two simultaneously open terminals with different selections.

For a deterministic mouse-aware smoke session, enable SGR any-motion reporting in a disposable terminal, perform the selection journey, then disable the modes before exit:

```bash
printf '\e[?1003h\e[?1006h'
printf '\e[?1003l\e[?1006l'
```

Also deny clipboard permission to verify generic failure feedback, selection preservation, no partial paste, and successful exactly-once retry.

## 5. Evidence and delivery

Capture a current screenshot or short recording showing synthetic multiline text still selected while the terminal context menu is open with Copy enabled. A recording should also show passive pointer movement without deselection. Do not capture real commands, tokens, filesystem paths, or user output.

Before requesting review:

1. Confirm the code PR stays below 3,000 additions and 50 files, or split it along shared/native/web layers using the mandated stacked-PR workflow.
2. Use a Conventional Commit/PR title and include the required invariants section if any backend boundary changes unexpectedly.
3. Stop pushing once the review commit range is declared.
4. Wait for all CI and Greptile 5/5; fix or explicitly defer every finding with a linked issue.
5. Open a separate PR against private `FinnaAI/matrix-os-site`, updating `content/docs/` with shortcuts, right-click/Select All behavior, and selection behavior in mouse-aware apps.

For release verification, remember that the web shell ships in the customer VPS host bundle, while native Electron Canvas/Desktop follow the desktop packaging/release path. A host-bundle publish alone does not update the installed native desktop application.
