# Task 9: Matrix Skills — Rewrite Report

## Status: DONE

## What was kept

- All seven skills from `skills/matrix/` (verified against directory listing) — names and descriptions updated to match the actual SKILL.md frontmatter `description` fields exactly.
- Runtime discovery paths table (all four consumers: Matrix kernel, Codex, Claude Code, Hermes).
- Sync command and `MATRIX_SKILL_TARGETS` env var pattern from CLAUDE.md.
- "Skills are not secrets" Callout.

## What was cut

- "Onboarding option" section: the `Help me onboard this repo` agent prompt was informal, not part of the canonical skill story, and not referenced anywhere in CLAUDE.md. Removed as stale internal detail.

## What was changed

- Replaced the skill pack raw markdown table with `Cards` component (consistent with other guide pages: `coding-agents.mdx`, `hermes.mdx`).
- Updated `description` frontmatter: old version said "preloaded for Claude, Codex, Hermes, and the Matrix kernel" — new version is more precise about what skills actually are ("canonical Matrix skill pack that coding agents use").
- Added `import { Card, Cards }` import (was missing from the original; page only imported Callout).
- Added one sentence explaining _what_ a skill is (Markdown with frontmatter, loaded by agents) — original jumped straight to the table without defining the concept.
- Runtime paths section renamed from "Runtime paths" to "Where agents find skills" for user-facing clarity.
- Sync section reworked with a brief "Re-run after pulling skill updates" note.

## Uncertainties

- None. Skill directory listing and frontmatter confirmed all seven skills are current. CLAUDE.md "Canonical Matrix skill pack" section is reflected accurately.
