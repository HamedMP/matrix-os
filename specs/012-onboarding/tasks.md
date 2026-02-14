# Tasks: Personalized Onboarding

**Spec**: spec.md
**Task range**: T400-T412

## User Story

- **US8** (P0): "First boot asks who I am and sets up the OS for me"

## Tests (TDD -- write FIRST)

- [x] T400a [P] [US8] Write `tests/kernel/onboarding.test.ts` -- test `parseSetupPlan()`: reads setup-plan.json, returns typed plan object, handles missing file gracefully, validates required fields (role, apps array, skills array)

- [x] T400b [P] [US8] Write `tests/kernel/onboarding.test.ts` (merged with T400a) -- test `getPersonaSuggestions(role)`: returns apps/skills/personality for known roles (student, developer, investor, parent, creative, researcher, entrepreneur), returns generic defaults for unknown roles, returned apps have name + description

- [x] T400c [P] [US8] Covered by `tests/gateway/provisioner.test.ts` (T404b) -- provisioner tests cover plan triggers, sequential builds, status transitions, and broadcasting

## Implementation

### Phase A: Enhanced Bootstrap (conversation flow)

- [x] T400 [US8] Rewrite `home/system/bootstrap.md` -- full onboarding flow with role discovery, follow-up questions, persona-based setup proposal, and build instructions. Include persona templates inline (apps/skills/personality per role). Self-deletes after onboarding.

- [x] T401 [US8] Add `role` field to `home/system/user.md` template -- role field filled during onboarding. Backward-compatible (empty field is fine).

### Phase B: Persona Engine

- [x] T402 [US8] Implement `getPersonaSuggestions(role: string)` in `packages/kernel/src/onboarding.ts` -- maps role strings to recommended apps, skills, and personality traits. Handles known roles (student, developer, investor, entrepreneur, parent, creative, researcher) and returns sensible defaults for unknown/custom roles. Returns `{ apps: AppSuggestion[], skills: SkillSuggestion[], personality: PersonalityConfig }`.

- [x] T403 [US8] Implement `parseSetupPlan()` and `writeSetupPlan()` in `packages/kernel/src/onboarding.ts` -- reads/writes `~/system/setup-plan.json`. Zod schema for validation. Status field: `pending | building | complete`. Tracks `built[]` array of completed app names.

### Phase C: Parallel Provisioning Pipeline (T404)

- [x] T404a [P] [US8] Write `tests/gateway/dispatcher-batch.test.ts` -- test `dispatchBatch()`: single entry works, multiple run in parallel, batch blocks serial queue, partial failures return mixed results, empty batch resolves immediately, queue length counts batch as 1 entry (8 tests)

- [x] T404b [P] [US8] Write `tests/gateway/provisioner.test.ts` -- test provisioner: ignores non-pending plan, creates DB tasks per app, status transitions (pending -> building -> complete), broadcasts task:created + provision:start + provision:complete, handles partial failures (7 tests)

- [x] T404c [US8] Implement `dispatchBatch()` in `packages/gateway/src/dispatcher.ts` -- discriminated union queue (serial | batch), batch runs all entries via `Promise.allSettled()`, `batchRunning` flag blocks serial dispatches, returns `BatchResult[]`

- [x] T404d [US8] Add `GET /api/tasks` route + `broadcast()` helper + extend ServerMessage in `packages/gateway/src/server.ts` -- tasks endpoint reads from DB via `listTasks()`, new ServerMessage types: task:created, task:updated, provision:start, provision:complete

- [x] T404e [US8] Create `packages/gateway/src/provisioner.ts` -- `createProvisioner()` with `onSetupPlanChange()`: reads setup-plan.json, creates DB tasks, dispatches batch builds, broadcasts real-time events, updates plan status. Wired into file watcher in server.ts

- [x] T404f [US8] Extend shell ServerMessage types in `shell/src/hooks/useSocket.ts` -- added task:created, task:updated, provision:start, provision:complete event types

- [x] T404g [US8] Create `shell/src/hooks/useTaskBoard.ts` -- fetches GET /api/tasks on mount, subscribes to WebSocket events, derives todo/inProgress/done columns via filter, returns provision status

- [x] T404h [US8] Create `shell/src/components/TaskBoard.tsx` + `TaskCard.tsx` -- three-column kanban with provision status bar. TaskCard shows app name + status badge + agent label

- [x] T404i [US8] Integrated into Desktop.tsx left dock as overlay panel (not BottomPanel) -- KanbanSquare icon at top of dock, 420px slide-out overlay with backdrop dismiss

- [x] T405 [US8] Add `get_persona_suggestions` and `write_setup_plan` IPC tools in `packages/kernel/src/ipc-server.ts` -- kernel can call `get_persona_suggestions` to get defaults for a role, and `write_setup_plan` to persist the confirmed plan.

- [x] T406 [US8] Wire onboarding into `buildSystemPrompt()` -- detect setup-plan.json with status "building", include progress context in system prompt so kernel can report to user ("Study Planner is ready, building Flashcards next...").

### Phase D: Skill Templates

- [x] T407 [US8] Create onboarding skill templates in `home/agents/skills/` -- enhanced `reminder.md` (manage_cron IPC tool), added `study-timer.md` (Pomodoro), `budget-helper.md` (expense tracking). These are installed selectively based on persona.

### Phase E: Shell UX (optional, enhances experience)

- [x] T408 [US8] Add suggestion chips support for onboarding in `shell/` -- `SuggestionChips` `empty` context shows role chips (Student, Developer, Investor, Entrepreneur, Parent, Creative, Researcher). Clicking a chip sends the role as a message, bootstrap.md recognizes it as role selection.

- [x] T409 [US8] Superseded by T404h/T404i -- Kanban task board in dock overlay replaces simple progress indicator. Real-time task cards show build progress per app.

### Phase G: Post-Onboarding

- [x] T411 [US8] Implement welcome tour logic in bootstrap.md -- role-specific first actions after provisioning (e.g., "Try adding your Monday classes to the Study Planner" for students). Mentions remaining apps without overwhelming.

- [x] T412 [US8] Add re-onboarding capability -- `~/agents/skills/setup-wizard.md` skill that lets users re-run onboarding anytime ("reconfigure my OS", "I changed careers", "start fresh"). Preserves existing apps/data, writes new setup-plan.json to trigger provisioner.

## Task Dependencies

```
T400a, T400b, T400c, T404a, T404b  (tests -- write first)
      |
T400  (enhanced bootstrap.md)
T401  (user.md role field)
      |
T402  (persona engine)
T403  (setup plan read/write)
      |
T404c (dispatchBatch)
T404d (tasks API + broadcast + ServerMessage)
T405  (IPC tools)
T406  (system prompt integration)
      |
T404e (provisioner)
T404f (shell ServerMessage types)
      |
T404g (useTaskBoard hook)
T404h (TaskBoard + TaskCard)
T404i (BottomPanel integration)
      |
T407  (skill templates)
T408  (shell chips -- optional)
      |
T411  (welcome tour)
T412  (re-onboarding skill)
```

## Checkpoint

Fresh install. OS greets user. Asks "What do you do?" User picks "Student." OS asks 2 follow-ups (major, school level). User answers. OS proposes: Study Planner, Flashcards, Budget Tracker + summarize + reminder skills. User says "yes." Kanban board in BottomPanel shows 3 cards in "To Do". Cards move to "In Progress" as builders spawn. Apps build in parallel via `dispatchBatch()`. Cards slide to "Done" with elapsed time. OS says "Your Study Planner is ready -- try adding your Monday classes." Custom roles like "beekeeper" adapt with relevant apps.
