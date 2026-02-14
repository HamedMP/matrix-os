# Tasks: Personalized Onboarding

**Spec**: spec.md
**Task range**: T400-T412

## User Story

- **US8** (P0): "First boot asks who I am and sets up the OS for me"

## Tests (TDD -- write FIRST)

- [x] T400a [P] [US8] Write `tests/kernel/onboarding.test.ts` -- test `parseSetupPlan()`: reads setup-plan.json, returns typed plan object, handles missing file gracefully, validates required fields (role, apps array, skills array)

- [x] T400b [P] [US8] Write `tests/kernel/onboarding.test.ts` (merged with T400a) -- test `getPersonaSuggestions(role)`: returns apps/skills/personality for known roles (student, developer, investor, parent, creative, researcher, entrepreneur), returns generic defaults for unknown roles, returned apps have name + description

- [ ] T400c [P] [US8] Write `tests/gateway/onboarding-build.test.ts` -- test onboarding build flow: setup-plan.json triggers sequential app builds, each app dispatches to builder agent, plan status updates from "building" to "complete", built[] tracks completed apps

## Implementation

### Phase A: Enhanced Bootstrap (conversation flow)

- [x] T400 [US8] Rewrite `home/system/bootstrap.md` -- full onboarding flow with role discovery, follow-up questions, persona-based setup proposal, and build instructions. Include persona templates inline (apps/skills/personality per role). Self-deletes after onboarding.

- [x] T401 [US8] Add `role` field to `home/system/user.md` template -- role field filled during onboarding. Backward-compatible (empty field is fine).

### Phase B: Persona Engine

- [x] T402 [US8] Implement `getPersonaSuggestions(role: string)` in `packages/kernel/src/onboarding.ts` -- maps role strings to recommended apps, skills, and personality traits. Handles known roles (student, developer, investor, entrepreneur, parent, creative, researcher) and returns sensible defaults for unknown/custom roles. Returns `{ apps: AppSuggestion[], skills: SkillSuggestion[], personality: PersonalityConfig }`.

- [x] T403 [US8] Implement `parseSetupPlan()` and `writeSetupPlan()` in `packages/kernel/src/onboarding.ts` -- reads/writes `~/system/setup-plan.json`. Zod schema for validation. Status field: `pending | building | complete`. Tracks `built[]` array of completed app names.

### Phase C: Provisioning Pipeline

- [ ] T404 [US8] Implement `provisionFromPlan()` in `packages/kernel/src/onboarding.ts` -- reads setup-plan.json, builds each app sequentially via builder agent dispatch, creates skill files in `~/agents/skills/`, updates plan status as each item completes. Writes progress messages via IPC `send_message`.

- [x] T405 [US8] Add `get_persona_suggestions` and `write_setup_plan` IPC tools in `packages/kernel/src/ipc-server.ts` -- kernel can call `get_persona_suggestions` to get defaults for a role, and `write_setup_plan` to persist the confirmed plan.

- [x] T406 [US8] Wire onboarding into `buildSystemPrompt()` -- detect setup-plan.json with status "building", include progress context in system prompt so kernel can report to user ("Study Planner is ready, building Flashcards next...").

### Phase D: Skill Templates

- [ ] T407 [US8] Create onboarding skill templates in `home/agents/skills/` -- write 3-4 commonly needed skills as markdown files: `summarize.md` (enhance existing), `reminder.md` (enhance existing), `study-timer.md`, `budget-helper.md`. These are installed selectively based on persona.

### Phase E: Shell UX (optional, enhances experience)

- [ ] T408 [US8] Add suggestion chips support for onboarding in `shell/` -- when kernel response includes role suggestions, render as clickable chips in ChatPanel. Chips send the selected text as user message. Works with existing chip infrastructure if available, or add minimal chip rendering.

- [ ] T409 [US8] Add build progress indicator in shell -- when setup-plan.json exists with status "building", show progress bar or status text in the shell UI. App windows appear on desktop as each app completes.

### Phase F: Parallel Building (stretch, requires T054)

- [ ] T410 [US8] Upgrade `provisionFromPlan()` to support parallel builds -- when concurrent dispatch (T054) is available, fire all app builds simultaneously via `Promise.allSettled()`. Fall back to sequential if T054 not ready. Track individual build status in setup-plan.json.

### Phase G: Post-Onboarding

- [ ] T411 [US8] Implement welcome tour logic in bootstrap.md -- after all apps are built, guide user to the most relevant app first. Suggest a concrete first action ("Try adding your Monday classes to the Study Planner"). Don't overwhelm with everything at once.

- [ ] T412 [US8] Add re-onboarding capability -- `~/agents/skills/setup-wizard.md` skill that lets users re-run onboarding anytime ("reconfigure my OS", "I changed careers", "start fresh"). Creates new bootstrap.md, runs the flow again, preserves existing data the user wants to keep.

## Task Dependencies

```
T400a, T400b, T400c  (tests -- write first)
      |
T400  (enhanced bootstrap.md)
T401  (user.md role field)
      |
T402  (persona engine)
T403  (setup plan read/write)
      |
T404  (provisioning pipeline)
T405  (IPC tool)
T406  (system prompt integration)
      |
T407  (skill templates)
      |
T408  (shell chips -- optional)
T409  (shell progress -- optional)
      |
T410  (parallel builds -- stretch, needs T054)
      |
T411  (welcome tour)
T412  (re-onboarding skill)
```

## Checkpoint

Fresh install. OS greets user. Asks "What do you do?" User picks "Student." OS asks 2 follow-ups (major, school level). User answers. OS proposes: Study Planner, Flashcards, Budget Tracker + summarize + reminder skills. User says "yes." Apps build one by one, appearing on desktop. OS says "Your Study Planner is ready -- try adding your Monday classes." User types custom role like "I'm a beekeeper" -- OS adapts and proposes relevant apps (hive tracker, harvest log, weather alerts).
