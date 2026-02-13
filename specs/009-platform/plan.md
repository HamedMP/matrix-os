# Plan: Web 4 Platform Vision

**Spec**: `specs/009-platform/spec.md`
**Depends on**: 005-soul-skills, 006-channels, 008-cloud
**Estimated effort**: Very large (multi-phase, ongoing)

## Phase Overview

Organized by priority and dependency. P0 tasks target hackathon demo, P1 are demo-worthy, P2 are post-hackathon.

### Phase 13: Observability + Safety (P0)

**Goal**: Log all interactions, add safe mode agent. These are foundational for debugging and reliability.

1. Implement structured interaction logger (`~/system/logs/`)
2. Add log viewer endpoint (`GET /api/logs`)
3. Implement cost tracker (running total of AI spend)
4. Implement safe mode agent (minimal recovery, triggered on crash)
5. Add safe mode trigger in watchdog

### Phase 14: Identity System (P1)

**Goal**: Handle system for humans and AIs. Foundation for multi-user future.

1. Create handle registry (file-based for now: `~/system/handle.json`)
2. Implement `@username` and `@username_ai` naming convention
3. Create human profile (`~/system/profile.md`) and AI profile (`~/system/ai-profile.md`)
4. Modify SOUL to include handle-aware identity
5. Kernel responds to "who are you?" with handle and profile

### Phase 15: Git Sync (P1)

**Goal**: Sync home directory between local and cloud instances.

1. Implement `matrixos sync` command (git push/pull)
2. Add auto-sync on significant changes (debounced commit + push)
3. Add remote repo management (`matrixos remote add/remove`)
4. Handle merge conflicts (kernel-assisted resolution)
5. `.gitignore` management for sensitive/large files

### Phase 16: Mobile Experience (P1)

**Goal**: Matrix OS accessible from mobile devices.

1. Make web shell responsive (mobile breakpoints)
2. Dock becomes bottom tab bar on mobile
3. Windows become full-screen cards on mobile
4. Touch-friendly input bar
5. PWA manifest (installable on home screen)

### Phase 17: Multi-User Platform (P2)

**Goal**: Multiple users on shared infrastructure.

1. Central auth service (signup, login, handle management)
2. Per-user container/process isolation
3. User dashboard (manage your instance)
4. Handle discovery (search users by handle)
5. Admin panel (manage instances, monitor resources)

### Phase 18: Inter-Profile Messaging (P2)

**Goal**: Users and AIs can message each other across instances.

1. Message routing between instances
2. Sandboxed context for external requests (call center model)
3. Privacy controls (what's public vs private)
4. Rate limiting per external sender
5. Notification system for incoming messages

### Phase 19: App Marketplace (P2)

**Goal**: Share and monetize Matrix OS apps.

1. App packaging format (zip with manifest)
2. App registry (git-based or API)
3. `matrixos install` / `matrixos publish` commands
4. Browse/search UI in web shell
5. Monetization (Stripe integration, revenue split)

### Phase 20: AI Social (P2)

**Goal**: AI agents as public entities.

1. AI activity feed (public posts)
2. Follow/unfollow AIs
3. AI capability browser
4. Reputation scoring
5. Social API (get feed, post update)

### Phase 21: Distribution (P2)

**Goal**: Matrix OS as a standalone computing layer.

1. `matrixos` CLI shell command
2. Installer script for Linux servers
3. System packages (.deb, .rpm, snap)
4. Custom login/motd for dedicated servers
5. Desktop integration (Linux desktop entry)

## Critical Path for Hackathon

```
005 (SOUL) ──> 014 (Identity) ──> Demo
006 (Channels) ──> 018 (Inter-profile) ──> Demo
008 (Cloud) ──> 013 (Observability) ──> Demo
```

Phases 13-14 are achievable for hackathon. Phases 15-16 are stretch goals. Phases 17-21 are post-hackathon.

## Parallel Opportunities

- Phase 13 (Observability) and Phase 14 (Identity) are independent
- Phase 15 (Git Sync) and Phase 16 (Mobile) are independent
- All Phase 17-21 items are parallelizable with each other
