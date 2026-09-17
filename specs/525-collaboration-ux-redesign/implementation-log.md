# Implementation Log: Native Collaboration UX Redesign

## Confirmed Interaction Model

Confirmed by the product owner on 2026-09-17.

- Shared Chat uses the ordinary Matrix timeline, composer, AI rendering, and responsive frame.
- Desktop human discussion is a right-side in-session overlay drawer; mobile is a full-height bottom sheet.
- Access uses one compact summary popover and an owner-only second-level manager; discussion has a separate trigger.
- Shared with me is a first-class Chat navigation row with a bounded pending badge and no separate app/dock icon.
- Shared terminals retain the ordinary terminal viewport with compact access, discussion, role, and controller controls.

## Baseline

- Source: `origin/main` at `8b36039aa` (`feat(collaboration): resolve invitation identifiers (#1741)`).
- Manual worktree: `/home/nima/matrix-os-collaboration-ux-redesign` on branch `525-collaboration-ux-redesign`.
- Original checkout `/home/nima/matrix-os` contained unrelated user changes and remains untouched.
- Dependencies installed with the frozen lockfile using the existing offline store.
- Current-main verification: `pnpm --dir shell exec playwright test e2e/shared-chat.spec.ts` passed (1 test).
- Ignored baseline captures: `output/playwright/shared-chat/web-desktop-discussion.png`, `web-desktop-ai.png`, and `web-canvas-ai.png`.
- Observed baseline: collaboration-specific duplicate header, card transcript, Discussion/Ask AI composer switch, persistent queue weight, and Shared with me outside the Chat rail.

## Stack

1. `feat(collaboration): add discussion and invitation UX contracts`
2. `feat(chat): make shared sessions native`
3. `feat(collaboration): add native session layers`
4. `feat(collaboration): complete native terminal and discovery`
5. `feat(collaboration): align desktop and mobile surfaces`

Each layer must remain at or below 3,000 additions and 50 files, include current-head evidence for visible changes, pass its relevant checks, use `$worktree-pr-monitor`, reach Greptile 5/5, and stay unmerged until explicit product-owner approval.

## Red/Green and Validation Record

Commands and results are appended here as tasks complete. No production implementation begins before its paired failing test has been observed failing for the intended missing behavior.
