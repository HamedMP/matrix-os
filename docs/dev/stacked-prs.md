# Stacked PR Workflow

Use Graphite for features that naturally split into reviewable layers. The goal
is smaller PRs with explicit dependencies, not a large branch that reviewers
must understand all at once.

## When To Stack

Prefer stacked PRs when a feature crosses review boundaries such as:

- spec or docs groundwork
- gateway/backend contracts
- platform or deployment wiring
- shell/app UI
- follow-up live validation or rollout work

Keep each PR under the normal review target: ideally under 1000 additions and
20 files, never over 3000 additions or 50 files without splitting.

## Setup

Install and authenticate the Graphite CLI, then initialize it once in the repo:

```bash
gt auth
gt repo init
```

Check the current stack before changing it:

```bash
gt stack
```

## Create A Stack

Graphite works best when each branch is created from already-staged changes.
Do not create an empty branch first.

```bash
git status --short
gt sync

# Make the first logical slice, then:
gt add <files>
gt create -m "feat(messages): add setup contracts"

# Make the next dependent slice on top of the current branch, then:
gt add <files>
gt create -m "feat(messages): add permission gates"
```

Repeat this for each layer. The current branch becomes the parent of the next
`gt create` branch.

## Modify A Branch

Use `gt modify` when changing the current branch in a stack:

```bash
gt add <files>
gt modify
```

If you edit a lower branch, restack descendants before validating:

```bash
gt restack
```

Use `gt sync` regularly to pull trunk updates, clean up merged branches, and
restack where Graphite can do so safely.

## Submit A Stack

Submit the current branch and every downstack dependency:

```bash
gt submit
```

Submit the whole stack, including upstack descendants:

```bash
gt submit --stack
```

For a fast published stack update, use the alias:

```bash
gt ss -np
```

`gt submit` also updates existing PRs after more commits. Use
`gt submit --update-only` when the stack already has PRs and you do not want to
create new ones.

## Matrix OS Rules

- PR titles must be Conventional Commit titles, for example
  `feat(messages): add permission gates`.
- Backend PR bodies must include the required Invariants section from
  `docs/dev/review-pipeline.md`.
- Spec Kit features should preserve `tasks.md` phase boundaries as stack
  boundaries. The Speckit task template and implementation skill both expect
  multi-phase features to map phases/user stories to Graphite layers.
- Declare stack order in each PR body, for example `Stack: 1/4`, `Stack: 2/4`.
- Do not request deep review until the relevant PR is frozen or ready for
  review.
- If a stack layer fails broad baseline tests for unrelated reasons, record the
  exact failing tests in that PR body instead of marking the gate green.
- Do not flatten stacked branches into one large PR unless explicitly asked.
