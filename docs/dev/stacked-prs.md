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

For refactors of large source files, follow `docs/dev/large-file-refactoring.md`:
put guardrails in the base layer, keep mechanical extraction separate from
behavior changes, and aim for small composition files rather than moving code
around only to satisfy line-count targets.

## Setup

Install and authenticate the Graphite CLI, then initialize it once in the repo:

```bash
gt init
```

The CLI prompts for the trunk branch, normally `main`, and stores config in
`.git/.graphite_repo_config`. If `gt` is not installed or authenticated, stop
and fix that before creating, submitting, or updating Matrix OS stacks.

Check the current stack before changing it:

```bash
gt log short
# or:
gt ls
```

## Create A Stack

Use Graphite for branch creation and commits. Start from trunk for the first
layer, then create each upstack layer from its parent branch.
Use the trunk name selected during `gt init`; in this repo it is usually
`main`.

```bash
gt checkout <trunk>
gt sync

# Make the first logical slice, then:
gt create --all --message "feat(messages): add setup contracts"

# Make the next dependent slice on top of the current branch:
gt create --all --message "feat(messages): add permission gates"
```

Repeat this for each layer. The current branch becomes the parent of the next
`gt create` branch.

## Modify A Branch

Use `gt modify` when changing the current branch in a stack:

```bash
gt modify --all
```

If you need a separate follow-up commit instead of amending the current branch:

```bash
gt modify --commit --all --message "fix(messages): address review feedback"
```

If you edit a lower branch, Graphite normally restacks descendants for
`gt modify`. If manual conflict repair is needed, restack descendants before
validating:

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

Open the current PR or stack in Graphite after submitting:

```bash
gt pr
```

For a fast published stack update, use the alias:

```bash
gt ss -np
```

`gt submit` also updates existing PRs after more commits. Use
`gt submit --update-only` when the stack already has PRs and you do not want to
create new ones.

## Matrix OS Rules

- Use Graphite commands for Matrix OS stack operations. Prefer `gt checkout`,
  `gt create --all --message`, `gt modify --all`, `gt submit --stack`,
  `gt sync`, `gt restack`, `gt top`, and `gt pr` over raw git/gh equivalents
  when creating, updating, publishing, and opening stacked PRs.
- If Graphite is missing or unauthenticated, treat that as an environment
  blocker for stack operations and install/authenticate it instead of silently
  falling back to raw git for stack work.
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
