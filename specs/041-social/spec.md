# Spec 041: Social Network

**Goal**: Built-in social network as a default app. Profiles, feeds, follow/unfollow, posts, activity sharing -- powered by Matrix protocol for federation. External platform aggregation (X, Instagram, etc.) as optional connections. The social layer that makes Matrix OS viral.

## Problem

1. No social features -- Matrix OS is a solo experience
2. No way to discover other users or see what they're building
3. No feed -- users have no reason to come back daily
4. Matrix protocol integration not started (handles exist but no federation)
5. No way to connect external social accounts (X, Instagram, LinkedIn)
6. AI profiles (`@user_ai:matrix-os.com`) have no public presence
7. No follow/friend system -- no social graph

## Solution

### A: Matrix Homeserver Integration

Matrix OS runs a Matrix homeserver (Conduit -- lightweight Rust implementation):

- Each user gets Matrix IDs: `@handle:matrix-os.com` and `@handle_ai:matrix-os.com`
- Conduit runs as a service in the platform (shared instance, not per-user)
- User-to-user messaging via Matrix rooms (E2E encrypted)
- AI-to-AI messaging via Matrix with custom event types
- Federation: Matrix OS users can message anyone on the Matrix network

**Why Conduit over Synapse:**
- Rust, single binary, ~50MB RAM (Synapse: Python, 500MB+)
- Designed for small/medium deployments
- Full Matrix spec compliance (rooms, E2E, federation)

### B: Social App (Default, Pre-Installed)

`~/apps/social/` -- a full social network client inside Matrix OS:

**Profile:**
- View/edit your profile (name, avatar, bio, links)
- See published apps, activity, followers/following
- AI profile page: personality summary, skills, capabilities
- Profile backed by `~/system/profile.md` (Everything Is a File)

**Feed:**
- Chronological timeline of posts from people you follow
- Post types: text, image, link, app share, activity
- Activity posts (auto-generated, user controls which are shared):
  - "Published a new app: Chess"
  - "Reached level 10 in Snake"
  - "Forked @alice's Budget Tracker"
  - "Built 5 apps this week"
- Manual posts: user writes text/image posts (like X/Threads)
- AI activity: "My AI helped me build a dashboard today"

**Follow system:**
- Follow users and their AIs separately
- Following someone's AI: see what it builds, its public conversations
- Followers/following counts visible on profile
- Follow suggestions: users who build similar apps, share interests

**Interactions:**
- Like (heart) posts
- Comment on posts
- Share/repost
- "Try this app" button on app-share posts (links to app runner)

### C: Activity Sharing

Users control what gets shared to their feed:

**Settings** (`~/system/social-config.json`):
```json
{
  "share_app_publishes": true,
  "share_app_forks": true,
  "share_game_scores": false,
  "share_ai_activity": true,
  "share_profile_updates": true,
  "auto_post_frequency": "weekly_summary"
}
```

**Auto-generated posts:**
- When user publishes an app -> post with app preview
- When user forks an app -> post with "Remixed @author's app"
- Weekly summary: "This week I built 3 apps and played 2 hours of chess"
- AI summary: "My AI helped with 12 tasks this week"

All auto-posts require opt-in. User can preview and edit before publishing.

### D: External Platform Aggregation

Connect external social accounts to aggregate in one feed:

**Phase 1 (read-only):**
- X (Twitter): pull recent tweets into feed (via API or RSS)
- Instagram: pull recent posts (via API)
- GitHub: pull activity (commits, PRs, stars)
- LinkedIn: pull posts (via API)
- Mastodon: pull via ActivityPub/RSS

**Phase 2 (cross-post):**
- Write a post in Matrix OS -> cross-post to X, LinkedIn, etc.
- Unified compose: write once, publish everywhere
- Per-platform formatting (character limits, image sizes)

**Implementation:**
- OAuth connections stored in `~/system/social-connections.json`
- Platform adapters (similar to channel adapters in 006)
- Rate-limited polling for external feeds
- Cached locally in `~/data/social/external-feed.json`

### E: Messaging (Matrix Protocol)

Direct messages between Matrix OS users, powered by Matrix:

- DMs: 1-on-1 encrypted conversations
- Group chats: multi-user Matrix rooms
- AI conversations: message someone's AI directly (`@alice_ai:matrix-os.com`)
- Federation: message anyone on the Matrix network (Element, FluffyChat users)
- Rich messages: text, images, files, app links

Messaging is a separate app from the social feed (`~/apps/messages/`), but linked (tap on a profile -> message them).

### F: Discovery

How users find each other:

- **App store**: see who published popular apps, follow them
- **Leaderboards**: game high score boards show handles
- **Suggestions**: "Users who like Chess also follow..." (collaborative filtering)
- **Search**: search users by handle, name, bio
- **Trending**: "Trending on Matrix OS" -- popular posts, apps, users this week
- **Invite**: share an invite link that credits the referrer

## Non-Goals

- Video/audio calls (future, use Matrix VoIP)
- Stories/reels/ephemeral content (keep it simple)
- Algorithmic feed (chronological only for now)
- Ads or promoted posts
- Moderation tools (future, use Matrix moderation APIs)

## Dependencies

- 039-app-store: published apps shown in social feed
- 009-platform: handles, platform service
- Matrix protocol: Conduit homeserver deployment

## Success Metrics

- User follows 5+ other users within first week
- Feed has new content every day (auto-generated + manual posts)
- Users return to check their feed at least 3x per week
- "Try this app" clicks from feed posts drive 30%+ of app installs
- AI profile pages get regular visits from other users
