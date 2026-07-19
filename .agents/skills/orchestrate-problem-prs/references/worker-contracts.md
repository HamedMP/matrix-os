# Worker Contracts

## Contents

1. Investigation assignment
2. Root-cause dossier
3. Draft PR bootstrap assignment
4. Root-cause comment
5. Resolution-plan comment
6. Implementation unlock
7. Completion report

## Investigation Assignment

```text
You own exactly one problem: <problem ID and title>.

Source context: <PR, commit, incident, or preview context>
Pinned base SHA: <SHA>
Repository instructions: Re-read <applicable AGENTS.md or CLAUDE.md paths> and
<constitution path> before investigating; those rules remain authoritative.
Raw problem evidence: <relevant unedited report excerpt and artifact links>
Expected behavior: <expected behavior>
Explicit exclusions: <out-of-scope symptoms or workstreams>

Investigate in strict read-only mode. Do not edit files, create a branch or
worktree, commit, push, open a PR, apply labels, or write comments. Trace the
behavior to its first incorrect state transition, assumption, or trust
boundary. Return the root-cause dossier below. Do not propose implementation
as a substitute for proving the cause.
```

## Root-Cause Dossier

```markdown
## <problem ID>: <title>

### Observed and expected behavior
<precise comparison>

### Reproduction or execution trace
<steps or deterministic control/data-flow trace>

### Evidence
- `<file:line>` — <what the code proves>
- <log, screenshot, test, PR-diff, or history evidence>

### Root cause
<first incorrect state transition, assumption, or boundary violation>

### Relationship to the source change
<how it was introduced or exposed>

### Alternatives ruled out
- <alternative> — <contradicting evidence>

### Affected scope and risks
<users, surfaces, data, concurrency, security, or compatibility>

### Regression-test design
<focused test and why it fails before the fix>

### Confidence and unknowns
Confidence: <high, medium, or low>
Unknowns: <remaining uncertainty or `none`>
```

High confidence requires direct code evidence plus either reproduction or a
deterministic trace. Medium or low confidence does not pass the mutation gate.

## Draft PR Bootstrap Assignment

```text
Your read-only diagnosis for <problem ID> is accepted. Use only the assigned
manual worktree, branch, and PR title below:

Worktree: <absolute path>
Branch: <semantic branch>
PR title: <Conventional Commit title>
Base SHA: <pinned SHA>

Add the focused failing regression test without changing production code. Run
it and capture the expected failure. Commit and push that test, open a draft
PR, then post the root-cause and resolution-plan comments as separate comments.
Return the PR, commit, command/output summary, and both comment URLs. Stop after
the comments; implementation remains locked.
```

## Root-Cause Comment

```markdown
## Root-cause analysis

**Problem:** <observed versus expected behavior>

**Reproduction/trace:** <concise steps or execution path>

**Root cause:** <first incorrect transition, assumption, or boundary>

**Evidence:**
- `<file:line>` — <explanation>
- <other direct evidence>

**Source-change relationship:** <introduced or exposed>

**Affected scope:** <scope and risks>

**Alternatives ruled out:** <alternatives and evidence>

**Confidence:** High — <why>

**Remaining unknowns:** <unknowns or `None`>
```

## Resolution-Plan Comment

```markdown
## Resolution plan

1. **Red:** <failing regression test and asserted behavior>
2. **Green:** <smallest production change that addresses the proven cause>
3. **Refactor:** <cleanup that preserves the behavior>
4. **Failure and security review:** <validation, concurrency, cleanup, error,
   resource, and trust-boundary considerations>
5. **Validation:** <focused tests, typecheck, pattern scan, unit tests, and any
   integration or end-to-end checks>
6. **Frontend evidence:** <React Doctor and screenshot plan, or `Not applicable`>
7. **Documentation:** <public/internal documentation impact>
8. **Dependencies:** <other PRs and merge order, or `None`>

**Deferred scope:** <explicit exclusions>
```

## Implementation Unlock

```text
Implementation is authorized for <problem ID> in <worktree and PR>. Follow the
approved plan and Red -> Green -> Refactor. Do not expand scope without
returning to the coordinator. Commit working increments. After local validation,
mark the draft PR ready for review, verify it is no longer a draft, then invoke
$worktree-pr-monitor for this single assigned PR. Do not merge.
```

## Completion Report

```markdown
## <problem ID> completion

- PR: <URL>
- Worktree: `<absolute path>`
- Branch: `<branch>`
- Current SHA: `<SHA>`
- Root cause: <one-sentence cause>
- Focused checks: <commands and results>
- Broad checks: <commands and results>
- Greptile: `5/5` for <current SHA or review timestamp evidence>
- `ready-for-ci`: <applied/verified>
- Label-triggered CI: <passing checks>
- Dependencies: <order or `None`>
- Skipped checks/residual risk: <details or `None`>
```
