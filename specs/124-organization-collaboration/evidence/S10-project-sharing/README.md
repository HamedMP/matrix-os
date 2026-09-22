# S10 project sharing — rendered evidence

Six screenshots of the two user-visible surfaces this layer changes, rendered in Chromium at
`deviceScaleFactor: 2` from the branch's own component source with fixtures that satisfy the
components' Zod schemas.

## Project sharing dialog

Each shot shows both new features: the per-Chat execution-root line and the new **Owner Git setup**
section.

| file | state |
| --- | --- |
| `01-project-sharing-dialog-git-ready.png` | identity ready, GitHub ready. Also shows both root variants: `Chat worktree wt_launch_review / Branch: feature/launch-review / Uncommitted changes`, and `Project root / Branch: main` |
| `02-project-sharing-dialog-git-missing.png` | both missing, with the remediation copy |
| `03-project-sharing-dialog-git-unavailable.png` | both unavailable |
| `04-project-sharing-dialog-identity-ready-github-missing.png` | mixed: identity ready, GitHub missing |

## Session access popover

| file | state |
| --- | --- |
| `05-session-access-readiness-git-ready.png` | readiness section, both roots, both Git lines ready |
| `06-session-access-readiness-git-missing.png` | same, both Git lines missing |

## What these do not cover

Honest scope, so nobody reads more into them than they show:

- `unavailable` on the access popover, the `Chat root unavailable` blocked line, and the
  `No project Chats yet.` empty state were not captured.
- These render the shared `packages/ui` components in an isolated harness, **not the shipped shell**.
  The markup and copy are the branch's; the surrounding chrome is harness-supplied, loading the
  desktop design tokens plus a small bridge for the shadcn colour roles.

## A parity question these renders surfaced

The same states carry **different copy** on the two surfaces:

| state | dialog | popover |
| --- | --- | --- |
| GitHub ready | "GitHub access is ready for push and pull requests." | "GitHub access is ready." |
| GitHub missing | "GitHub access is missing. Connect the owner's GitHub account before push or pull requests." | "GitHub access is missing." |

The state semantics match; only the remediation sentence differs. The dialog is where an owner acts
on the problem, so it carries the guidance, while the popover is a status glance. That is a
defensible split, but the repo's surface-parity rule asks for divergence to be recorded rather than
assumed, so it is recorded here for a reviewer to accept or reject.

`SessionAccessControl` also gains `max-h-[70vh] overflow-y-auto`, which matters because the new
readiness section makes the popover materially taller — visible in shots 05 and 06.
