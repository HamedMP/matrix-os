# Spec 043: Quality, UX, and Social

Consolidates remaining work from specs 036, 038, 039, 041 and adds new Chat UX requirements.

## Problem

1. **Chat UX is noisy**: Tool calls show as individual lines ("Edit", "Edit", "Edit" x20) with no context. No grouping, no collapsibility, no file paths shown.
2. **Pre-installed apps are stubs**: Games, calculator, social, profile, messages are placeholder HTML. Not production quality.
3. **Social network doesn't work**: No backend API endpoints. Social/messages/profile apps fetch endpoints that don't exist.
4. **AI-built apps are low quality**: Generated apps lack theming, responsiveness, bridge API integration.
5. **Parallel messages work but responses aren't multiplexed**: User can send while busy, but streaming responses can't be attributed to specific requests.

## Goals

- Every pre-installed app is polished, themed, responsive, and functional
- Social network has working feed, posts, follows, profiles
- Messaging app works with real conversation data
- Chat panel groups tool calls, shows context, supports collapsing
- AI generates high-quality apps with proper Matrix OS integration
- User can send multiple messages and see responses independently

## Non-Goals

- External platform connectors (X, Instagram, GitHub) - future
- Matrix homeserver deployment (Conduit) - infrastructure
- S3 sync, PostgreSQL addon - infrastructure (spec 040)
- Chromium/VS Code Docker containers - infrastructure
- App marketplace monetization - future
- Skills store / publishing - separate scope

## Architecture

### Chat UX

The ChatPanel renders messages as a flat list. Tool-type messages need to be grouped by assistant turn and rendered as a collapsible block showing count + summary. Each tool call should display: tool name, primary argument (file path for Edit/Read, command for Bash), and status. The group defaults to collapsed, expandable on click.

For parallel responses: each `dispatch()` call tags the kernel with a `requestId`. Kernel events on the WebSocket include this ID. The shell tracks multiple active responses and renders them in separate sections or interleaved with clear attribution.

### Pre-installed Apps

All apps in `home/apps/` are self-contained HTML files served via `/files/apps/`. They must:
- Use CSS custom properties for theming (`--matrix-bg`, `--matrix-fg`, `--matrix-accent`, `--matrix-border`, `--matrix-card-bg`)
- Be responsive (work in 320px-wide windows and full-screen)
- Use `/api/bridge/data` for persistence (scoped by app name)
- Have smooth animations and polished visuals
- Include proper error states and loading states

### Social Network

Gateway gets new routes under `/api/social/` backed by SQLite tables (Drizzle ORM):
- `posts` table: id, authorId, content, type, parentId, createdAt
- `follows` table: followerId, followeeId, createdAt
- `likes` table: userId, postId, createdAt

Social app rebuilt as a polished HTML app that fetches these endpoints. Profile app fetches `/api/profile` + `/api/social/posts?author=`. Messages app uses existing `/api/conversations` endpoints.

### AI App Building

Improved build skills in `home/agents/skills/` that produce apps with:
- matrix.json manifest
- CSS variable theming (inherits OS theme)
- Bridge API persistence
- Responsive layout
- Error handling

## Migrated Tasks

From spec 038 (App Platform): T1420-T1427 (games), T1430-T1433 (utilities), T1440-T1445 (build skills)
From spec 039 (App Store): T1490-T1493 (personal websites)
From spec 041 (Social): T1560-T1572 (social core + activity), T1590-T1594 (messaging)
From spec 036 (Builder Speed): T1310-T1315 (domain skills), T1322 (HTML fast path)
