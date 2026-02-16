# Plan: Settings Dashboard

**Spec**: `specs/030-settings/spec.md`
**Depends on**: Shell (complete), Gateway API (complete)
**Optional deps**: 025-security (audit), 029-plugins (plugin management)
**Estimated effort**: Large (18 tasks + TDD)

## Approach

Build the settings shell (layout, navigation, routing) first. Then implement sections in priority order: Agent (most used), Channels (most requested), Skills, Cron. Security and Plugins sections depend on their respective specs shipping first but the settings layout can exist before them.

### Phase A: Settings Shell (T970-T973)

1. Settings layout with sidebar navigation
2. Route structure (`/settings/*`)
3. Settings dock icon + Cmd+, keyboard shortcut
4. Mobile responsive: full-screen sections with back navigation

### Phase B: Agent + Channels (T974-T979)

1. Agent settings: SOUL markdown editor, identity display, agent file tabs
2. Markdown editor component (reusable, with preview)
3. Channel cards with status badges
4. Channel setup forms (expandable per channel)
5. Channel connection test

### Phase C: Skills + Cron (T980-T984)

1. Skills grid with status badges and toggles
2. Skill detail view (markdown preview)
3. Cron job list with status
4. Cron job create/edit form
5. Cron expression builder helper

### Phase D: Security + Plugins + System (T985-T990)

1. Security audit dashboard (findings with remediation)
2. Exec rules editor
3. Plugin list with capabilities
4. Plugin install/uninstall
5. System info + health + logs
6. Theme picker + about

## Files to Create

- `shell/src/app/settings/` -- all page routes
- `shell/src/components/settings/` -- all settings components
- `packages/gateway/src/routes/settings.ts` -- settings API endpoints

## Files to Modify

- `shell/src/app/layout.tsx` -- add settings route
- `shell/src/components/Desktop.tsx` -- add settings dock icon
- `shell/src/lib/commands.ts` -- add Cmd+, shortcut
- `packages/gateway/src/index.ts` -- mount settings routes
