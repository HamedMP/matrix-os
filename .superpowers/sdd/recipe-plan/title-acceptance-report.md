# Chat rail title acceptance

## Change

`ChatApp` now constrains only its conversation-list `ScrollArea`: the local
Radix viewport content wrapper is forced from intrinsic `display: table` sizing
to a shrinkable block with `min-width: 0`. The rail itself is also shrinkable.
This leaves vertical scrolling, the existing 40-character display shortening,
full button accessible name, selection, and rename behavior unchanged.

## Regression coverage

- Added a focused 200-character Web Chat row test. It verifies the row exposes
  the complete title as its accessible name, renders the shortened label with
  `...`, and remains selectable.
- Existing `chat-app-provider-state` coverage exercises header, rail
  double-click, and context-menu rename behavior as well as rail selection.

## Checks

Passed:

```text
pnpm exec vitest run tests/desktop/chat-copy-id.test.tsx --maxWorkers=1 --no-file-parallelism
# 9 passed

NODE_OPTIONS='--localstorage-file=/tmp/matrixos-chat-title-vitest-localstorage.json' \
  pnpm exec vitest run tests/shell/chat-app-provider-state.test.tsx --maxWorkers=1 --no-file-parallelism
# 15 passed

pnpm exec tsc --noEmit  # from shell/
# passed

npx --yes react-doctor@latest --verbose --scope changed --base HEAD shell
# scanned 2 files; one pre-existing ChatApp complexity warning, no finding from this change
```

The independent Web production build also passed (session 47769; log:
`/tmp/om214-title-acceptance-shell-build.log`).

Independent real-DOM acceptance measured the original 200-character title at
row 243px, content 259px, and viewport 259px with no horizontal overflow.
Visible ellipsis was confirmed at 1280px and 390px; the full 200-character AX
label remained available, and selecting the row opened the original synthetic
transcript.

## Limitations

jsdom does not calculate this Radix/Tailwind layout, so the focused unit test
covers accessible title, shortening, and selection rather than geometry. The
real-DOM measurement above is the visual acceptance. If Radix changes its
viewport content-wrapper DOM contract, this local selector should be revisited.

## Commit

This commit: `fix(chat): contain long conversation titles`
