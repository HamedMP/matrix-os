# Brain note conventions

Keep the vocabulary small and editable. Entity pages are readable Markdown; relationships are relative links and meaningful sentences.

| Folder | Meaning |
| --- | --- |
| `sources/` | Immutable original evidence, one file per source revision |
| `inbox/` | Owner material awaiting organization |
| `people/` | People, verified source identities, aliases |
| `organizations/` | Companies and teams mentioned in personal material |
| `projects/` | Goals/workstreams connecting sources |
| `ideas/` | Proposals and original thinking |
| `events/` | Meetings/events with scheduled/canceled/confirmed status |
| `decisions/` | Proposed/adopted/reversed decisions and rationale |
| `tasks/` | Explicit commitments/open loops with supported owners/dates |
| `topics/` | Recurring themes connecting ideas |

Use flat lowercase filenames such as `onboarding.md` and `alex-product.md`. Reuse stable names. Disambiguate people rather than merging on name similarity. Never put private notes in a public code repository.

Example entity page (illustrative only):

```markdown
---
type: idea
status: proposed
aliases: [shorter-signup, onboarding-friction]
updated: 2026-10-03
---

# Shorter signup

## Evidence

An owner note proposed reducing signup steps. It did not assign a task or launch date.

> "We could test a shorter signup flow."

[Original evidence](../sources/REAL-SOURCE-REVISION.md)

## Connections

- Applies to [Onboarding](../projects/onboarding.md).
- Discussed with [Alex](../people/alex-product.md); identity needs review.

## History and corrections

Keep later changes, competing evidence, and owner corrections here.
```

Use `proposed`, `supported`, `confirmed`, `disputed`, `superseded`, or `unknown`. Confirmation requires evidence or an explicit owner correction; model confidence is insufficient.

Links can express works for, participates in, about, proposed by, supports, contradicts, and supersedes. Keep claims evidence-linked. Add new evidence to history instead of overwriting corrections. INDEX records coverage, caps, last successful refresh, pending sync, and review flags.
