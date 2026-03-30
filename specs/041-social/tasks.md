# Tasks: Social Network

**Spec**: spec.md
**Task range**: T1550-T1599
**Parallel**: Conduit (A) is foundation. Social app (B) and messaging (E) depend on it. External aggregation (D) is independent. Activity sharing (C) depends on B.
**Deps**: 009-platform (handles), 039-app-store (app publish events), Matrix protocol

## User Stories

- **US79**: "I can see a feed of what other Matrix OS users are building and posting"
- **US80**: "I can follow other users and their AIs"
- **US81**: "When I publish an app, my followers see it in their feed"
- **US82**: "I can message any Matrix OS user directly, with encryption"
- **US83**: "I can connect my X/Instagram and see everything in one feed"
- **US84**: "I can control what activities are shared publicly"
- **US85**: "I can see and visit other users' AI profiles"

---

## Phase A: Matrix Homeserver (T1550-T1554)

### Tests (TDD)

- [ ] T1550a [US82] Write `tests/platform/matrix-integration.test.ts`:
  - Create Matrix user on Conduit for new Matrix OS handle
  - Login returns access token
  - Create DM room between two users
  - Send message, receive message
  - Federation: test with mock external homeserver

### T1550 [US82] Conduit deployment
- [ ] Add Conduit to `docker-compose.platform.yml`
- [ ] Configuration: server_name `matrix-os.com`, database path, federation enabled
- [ ] Reverse proxy: `/_matrix/*` routes to Conduit
- [ ] Well-known files: `.well-known/matrix/server` and `.well-known/matrix/client`
- [ ] Health check: `GET /_matrix/client/versions`

### T1551 [US82] User provisioning
- [ ] On new user signup: create Matrix account via Conduit admin API
- [ ] `@handle:matrix-os.com` for human
- [ ] `@handle_ai:matrix-os.com` for AI
- [ ] Store Matrix access tokens in user's `~/system/matrix-credentials.json` (encrypted)
- [ ] Platform stores mapping: `matrix_users` table (handle -> matrix_id -> access_token)

### T1552 [US82] Matrix client library
- [ ] Create `packages/gateway/src/matrix-client.ts`
- [ ] Wrapper around `matrix-js-sdk` (or lightweight HTTP client)
- [ ] Methods: `sendMessage(roomId, content)`, `createDM(userId)`, `joinRoom(roomId)`, `sync()`
- [ ] Used by both gateway (for AI messages) and social app (for user messages)

### T1553 [US82] AI Matrix integration
- [ ] AI agent can send Matrix messages via IPC tool: `send_matrix_message({ to, content })`
- [ ] AI receives Matrix messages (routed through dispatcher like channel messages)
- [ ] Custom event types for AI-to-AI: `m.matrix_os.ai_request`, `m.matrix_os.ai_response`
- [ ] Sandboxed: external messages to AI go through call-center model (limited context)

---

## Phase B: Social App - Core (T1560-T1569)

### T1560 [US79] Social app scaffold
- [ ] `home/apps/social/` with matrix.json
- [ ] React app (Vite or Next.js) running on app runtime (038)
- [ ] Routes: /feed, /profile/:handle, /explore, /settings
- [ ] Navigation: bottom tab bar (Feed, Explore, Messages, Profile)
- [ ] Theme integration: uses Matrix OS CSS variables

### T1561 [US79] Feed data model
- [ ] Platform API posts table:
  ```
  posts: id, author_id, content, type (text|image|link|app_share|activity),
         media_urls, app_ref, likes_count, comments_count, created_at
  ```
- [ ] comments table: `id, post_id, author_id, content, created_at`
- [ ] likes table: `post_id, user_id, created_at`
- [ ] feed API: `GET /api/social/feed?cursor=...` (paginated, from followed users)

### T1562 [US79] Feed UI
- [ ] Scrollable feed of post cards
- [ ] Post card: avatar, handle, timestamp, content, media, like/comment/share buttons
- [ ] App share post: embedded app preview with "Try it" button
- [ ] Activity post: styled differently (lighter, less prominent)
- [ ] Pull-to-refresh, infinite scroll
- [ ] Empty state: "Follow some users to see their posts here" + suggestions

### T1563 [US80] Follow system
- [ ] follows table: `follower_id, following_id, following_type (user|ai), created_at`
- [ ] API: `POST /api/social/follow`, `DELETE /api/social/unfollow`
- [ ] API: `GET /api/social/followers/:handle`, `GET /api/social/following/:handle`
- [ ] Follow button on profiles, search results, app author pages
- [ ] Follow counts on profile

### T1564 [US80] Profile pages
- [ ] User profile: avatar, name, bio, handle, followers/following, published apps, recent posts
- [ ] AI profile: personality from SOUL, skills list, capabilities, recent AI activity
- [ ] Edit profile: inline editing for own profile (syncs to ~/system/profile.md)
- [ ] "Message" button -> opens DM
- [ ] "Follow" / "Unfollow" button

### T1565 [US79] Compose post
- [ ] "New post" button (floating action button on feed)
- [ ] Compose modal: text input, image upload, app link picker
- [ ] Character limit: 500 (longer than X, shorter than blog)
- [ ] Image upload: via gateway file API
- [ ] Preview before posting

### T1566 [US79] Interactions
- [ ] Like: toggle heart, optimistic update, increment count
- [ ] Comment: threaded comments under posts
- [ ] Share: repost to own feed with optional quote
- [ ] "Try this app" on app shares: navigates to app runner (039)

### T1567 [US79] Explore page
- [ ] Trending posts (most liked in last 24h)
- [ ] Trending apps (most installed in last 7d)
- [ ] Suggested users to follow
- [ ] Search: users, posts, apps (unified search bar)

---

## Phase C: Activity Sharing (T1570-T1574)

### Tests (TDD)

- [ ] T1570a [US81][US84] Write `tests/gateway/social-activity.test.ts`:
  - App publish triggers activity post (if enabled)
  - Game score triggers activity post (if enabled)
  - Disabled activities don't generate posts
  - Weekly summary generated correctly
  - User can preview and cancel auto-posts

### T1570 [US81] Activity event system
- [ ] Create `packages/gateway/src/social-activity.ts`
- [ ] Hook into existing events: app publish, app fork, game score, AI interaction
- [ ] Each event checks social-config.json for opt-in
- [ ] If enabled: create post via platform social API
- [ ] Template per activity type: "Published [app] - try it!"

### T1571 [US84] Social settings
- [ ] `~/system/social-config.json` with defaults (all activity sharing off)
- [ ] Settings page in social app: toggles for each activity type
- [ ] Preview: "When you publish an app, your followers will see: [preview]"
- [ ] Chat: "enable app publish sharing" -> AI updates config

### T1572 [US81] Weekly summary
- [ ] Cron job: every Sunday, generate weekly summary post
- [ ] Stats: apps built, games played, AI interactions, files created
- [ ] "My week on Matrix OS" post with stats card image
- [ ] Only posted if user has opted in (`auto_post_frequency: "weekly_summary"`)

---

## Phase D: External Platform Aggregation (T1580-T1584)

### T1580 [US83] Connection framework
- [ ] Create `packages/gateway/src/social-connectors/`
- [ ] `SocialConnector` interface: `connect()`, `disconnect()`, `fetchPosts(since)`, `crossPost(content)`
- [ ] OAuth flow: redirect to provider, callback stores tokens
- [ ] Connections stored in `~/system/social-connections.json`
- [ ] Refresh tokens automatically

### T1581 [US83] X (Twitter) connector
- [ ] OAuth 2.0 with PKCE
- [ ] Fetch recent tweets (user timeline API)
- [ ] Display in feed with X branding and "View on X" link
- [ ] Cross-post: format for 280 chars, post via API
- [ ] Rate limits: cache 15-minute windows

### T1582 [US83] GitHub connector
- [ ] OAuth app for GitHub
- [ ] Fetch: recent commits, PRs, stars, issues
- [ ] Display as activity posts: "Pushed to repo/name", "Starred repo"
- [ ] No cross-post (GitHub doesn't have a feed)

### T1583 [US83] Instagram connector
- [ ] Instagram Basic Display API (or Graph API for business accounts)
- [ ] Fetch recent media (images, carousels)
- [ ] Display in feed with image preview and "View on Instagram" link
- [ ] Cross-post: image + caption via Graph API

### T1584 [US83] Mastodon connector
- [ ] Connect via instance URL + OAuth
- [ ] Fetch via Mastodon API (compatible with most ActivityPub servers)
- [ ] Display toots in feed
- [ ] Cross-post: format for 500 chars, post via API
- [ ] Federation bonus: Mastodon users can follow Matrix OS users natively (future)

---

## Phase E: Messaging App (T1590-T1594) -- BLOCKED on Phase A (Conduit/Matrix)

**Status**: Mock messages app removed. Real messaging requires Matrix protocol integration (Phase A: T1550-T1553). Do NOT build another mock -- wait for Conduit to be wired, then build messages on top of real Matrix rooms.

**Pre-requisites before starting Phase E:**
- T1550: Conduit deployed and reachable from gateway
- T1551: User provisioning creates Matrix accounts on signup
- T1552: Matrix client library (`matrix-js-sdk` or HTTP wrapper)
- T1553: AI Matrix integration (dispatcher routes Matrix messages)

### T1590 [US82] Messages app scaffold
- [ ] `home/apps/messages/` with matrix.json and Postgres storage
- [ ] Connects to Conduit via matrix-client (T1552) for all operations
- [ ] Routes: /conversations, /chat/:roomId, /new
- [ ] NO mock/simulated replies -- all messages go through Matrix protocol

### T1591 [US82] Conversation list
- [ ] List of DM and group conversations, sorted by recent activity
- [ ] Each row: avatar, name, last message preview, timestamp, unread count
- [ ] Search conversations
- [ ] "New conversation" button

### T1592 [US82] Chat view
- [ ] Message bubbles (left/right alignment for received/sent)
- [ ] Real-time: Matrix sync for live updates
- [ ] Message types: text, image, file, app link
- [ ] Read receipts, typing indicators (Matrix protocol native)
- [ ] E2E encryption indicator

### T1593 [US82] AI messaging
- [ ] Message someone's AI: `@alice_ai:matrix-os.com`
- [ ] AI responds via dispatcher (same as channel message)
- [ ] Sandboxed context: AI only knows public profile info of the requester
- [ ] Rate limit: 10 external AI messages per hour per sender

### T1594 [US82] Group chats
- [ ] Create group: select multiple users
- [ ] Matrix room with invite/join
- [ ] AI can participate in group chats (mention `@ai` to invoke)
- [ ] Room settings: name, topic, member management

---

## Phase G: Postgres Migration (T2050-T2056)

Migrate social and messages from SQLite/Drizzle to Postgres/Kysely via the app data layer (spec 050).

### Tests (TDD)

- [ ] T2050a Write `tests/gateway/social-postgres.test.ts`:
  - All social CRUD operations work via QueryEngine (insert, find, update, delete posts)
  - Like/unlike toggles correctly, likes_count stays in sync
  - Follow/unfollow works, follower/following counts correct
  - Feed returns posts from followed users only, with cursor pagination
  - Explore returns posts ordered by likes_count
  - Comments (posts with parent_id) work correctly
  - `enrichWithLiked` returns `liked: true/false` per post
  - Use pglite for in-memory Postgres (same pattern as app-db tests)

### T2050 Social `matrix.json` storage declaration
- [ ] Add `storage.tables` to `home/apps/social/matrix.json` with posts, likes, follows tables
- [ ] Add `storage.tables` to `home/apps/messages/matrix.json` (if messages uses social data)
- [ ] Tables auto-created on boot via app registry (same as todo app)

### T2051 Rewrite `social.ts` to use QueryEngine
- [ ] Replace all Drizzle/MatrixDB imports with QueryEngine/AppDb
- [ ] `createSocialRoutes(queryEngine, appSlug, getCurrentUser)` signature
- [ ] All CRUD functions use `queryEngine.find()`, `queryEngine.insert()`, etc.
- [ ] Complex queries (feed with IN clause, trending ORDER BY, cursor pagination) use `queryEngine.find()` with filter/orderBy/limit/offset
- [ ] Like/unlike uses `queryEngine.findOne()` + `queryEngine.insert()`/`queryEngine.delete()` + raw SQL for atomic counter update
- [ ] Remove `enrichWithLiked` N+1 pattern: use a single query with LEFT JOIN or batch lookup

### T2052 Remove social tables from kernel SQLite schema
- [ ] Delete `socialPosts`, `socialLikes`, `socialFollows` from `packages/kernel/src/schema.ts`
- [ ] Remove `SocialPost`, `SocialLike`, `SocialFollow` type exports from kernel
- [ ] Define social types in `packages/gateway/src/social.ts` (or `social-types.ts`)
- [ ] Update all imports across the codebase

### T2053 Wire social routes to Postgres in server.ts
- [ ] Pass `queryEngine` and `appRegistry` to `createSocialRoutes()` instead of `dispatcher.db`
- [ ] Ensure social app schema is registered on boot (same as todo)
- [ ] Graceful fallback if DATABASE_URL not set (return 503, not crash)

### T2054 Update social frontend to use MatrixOS.db for simple CRUD
- [ ] Post creation: `MatrixOS.db.insert('posts', {...})` instead of `fetch('/api/social/posts')`
- [ ] Post deletion: `MatrixOS.db.delete('posts', id)`
- [ ] Keep `/api/social/feed`, `/api/social/explore`, `/api/social/posts/:id/like` as server routes (complex queries that need server logic)
- [ ] `MatrixOS.db.onChange('posts', reload)` for real-time updates

### T2055 Update social tests
- [ ] Migrate existing 116 social tests from SQLite mocks to pglite
- [ ] Verify all tests pass with Postgres backend
- [ ] Add integration test: full flow (create post -> like -> comment -> feed shows it)

### T2056 Cleanup
- [ ] Remove SQLite migration code for social tables from kernel `db.ts`
- [ ] Remove `bridge-sql.ts` if no other consumers (deprecated in spec 050)
- [ ] Update CLAUDE.md to reflect social uses Postgres
- [ ] Update `home/agents/knowledge/app-data.md` with social data patterns

---

## Checkpoint

1. [ ] `bun run test` passes with all social tests
2. [ ] Conduit running: `curl /_matrix/client/versions` returns Matrix spec versions
3. [ ] Sign up new user -> Matrix account created automatically
4. [ ] Open social app -> see feed (empty state with suggestions)
5. [ ] Follow @alice -> her posts appear in my feed
6. [ ] Write a text post -> appears in followers' feeds
7. [ ] Publish an app with sharing enabled -> activity post in feed
8. [ ] Click "Try this app" on a feed post -> app runs
9. [ ] Send DM to another user -> encrypted message delivered
10. [ ] Message @alice_ai -> AI responds with sandboxed context
11. [ ] Connect X account -> tweets appear in feed
12. [ ] AI profile page shows skills and personality
13. [ ] Weekly summary post generated (opt-in)
14. [ ] Social data in Postgres (no SQLite): `SELECT * FROM social.posts` works
15. [ ] No social tables in kernel schema.ts
16. [ ] Social app frontend uses MatrixOS.db.* for CRUD
17. [ ] All 116+ social tests pass with pglite backend
