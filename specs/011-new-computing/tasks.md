# Tasks: New Forms of Computing

**Spec**: spec.md
**Task range**: T300-T319

These tasks are exploratory -- each has a "minimum viable" version that can be built incrementally on top of existing infrastructure. Dependencies on 005 (skills), 006 (channels), and 007 (cron) are noted.

## 1. Living Software

- [ ] T300 [P] Design usage telemetry format -- define `~/data/{app}/.usage.json` schema: click counts, navigation patterns, feature usage frequency, timestamps. Write to spec.
- [ ] T301 Add usage telemetry injection to builder agent prompt -- generated apps write interaction events to `.usage.json` via bridge API (`window.MatrixOS.writeData`)
- [ ] T302 Create `evolution` skill in `~/agents/skills/evolution.md` -- reads usage data, proposes app modifications based on patterns, generates diff for approval. (Depends on: T103-T105 skills system)
- [ ] T303 Wire evolution to cron -- periodic "evolution check" job reads usage data and triggers evolution skill if patterns detected. (Depends on: T120-T122 cron)
- [ ] T304 Evolution UX -- diff view in shell showing before/after, approve/reject buttons, git commit on approval with message "evolve: [description]"

## 2. Socratic Computing

- [ ] T305 [P] Add Socratic mode to builder agent prompt -- when request is ambiguous (no specific dimensions, data model, or user count), ask 2-3 clarifying questions before generating. Add ambiguity detection heuristic.
- [ ] T306 Store dialogue lineage in generated apps -- comment header with `<!-- Dialogue: ... -->` summarizing the design conversation. Queryable via "why was this built this way?"
- [ ] T307 Create `socratic` skill in `~/agents/skills/socratic.md` -- for non-app conversations (budgeting, planning, learning), engage in structured questioning rather than immediate answers. (Depends on: T103-T105 skills system)
- [ ] T308 Cross-channel dialogue continuity -- Socratic dialogue started on web continues on Telegram with full context. (Depends on: T106-T111 channels)

## 3. Intent-Based Interfaces

- [ ] T310 [P] Design intent file format -- `~/intents/*.md` with frontmatter: `name`, `triggers` (keyword list), `data_sources` (paths), `channel_behavior` (per-channel output format). Write to spec.
- [ ] T311 Create `~/intents/` in home template -- add to first-boot, document in onboarding
- [ ] T312 Intent matching in dispatcher -- when message matches intent triggers, load intent file and pass to kernel as context instead of bare prompt. (Depends on: T109 dispatcher)
- [ ] T313 Channel-specific intent rendering -- same intent produces dashboard on web, summary on Telegram, notification on mobile. (Depends on: T106-T111 channels)
- [ ] T314 Create example intent: `~/intents/track-expenses.md` -- demonstrates triggers, data sources, channel-specific output

## 4. Progressive Depth (Bruner)

- [ ] T315 [P] Design progressive depth layers -- map existing shell components to enactive/iconic/symbolic modes. Document which features belong to which layer.
- [ ] T316 Beginner mode -- simplified shell with voice/chat only, no visible file system. Toggled via user preference in SOUL or config.
- [ ] T317 Context-aware suggestion chips by depth -- beginner gets "Build a task tracker", intermediate gets "Customize theme", expert gets "Edit soul.md"

## Checkpoint

Minimum viable demo: ask "build me an expense tracker", kernel asks 2 clarifying questions (Socratic), builds the app, usage telemetry starts collecting, after simulated use the evolution skill proposes a layout change, user approves, git shows the evolution. On Telegram, the same expense data renders as a text summary (intent-based).
