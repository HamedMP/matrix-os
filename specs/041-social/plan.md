# Plan: Social Network

**Spec**: spec.md
**Tasks**: tasks.md

## Execution Order

```
Phase A: Matrix Homeserver (T1550-T1554)    -- foundation: identity + messaging protocol
  |
  +---> Phase B: Social App (T1560-T1567)   -- depends on A for user identity
  |       |
  |       +---> Phase C: Activity (T1570-T1572) -- depends on B for posting
  |
  +---> Phase E: Messaging App (T1590-T1594) -- depends on A for Matrix protocol
  |
Phase D: External Connectors (T1580-T1584) -- independent of A, but feeds into B

```

## Phase Breakdown

### Week 1: Matrix Foundation
- Deploy Conduit (T1550)
- User provisioning on signup (T1551)
- Matrix client library (T1552)
- AI Matrix integration (T1553)

### Week 2: Social App Core
- App scaffold + feed data model (T1560-T1561)
- Feed UI + compose (T1562, T1565)
- Follow system (T1563)
- Profile pages (T1564)

### Week 3: Messaging + Interactions
- **Stream 1**: Messages app (T1590-T1594) -- DMs, group chat, AI messaging
- **Stream 2**: Social interactions (T1566-T1567) -- likes, comments, explore page

### Week 4: Activity + External
- Activity sharing system (T1570-T1572)
- X connector (T1581) -- highest priority external platform
- GitHub connector (T1582)
- Instagram + Mastodon (T1583-T1584)

## Key Decisions

1. **Conduit over Synapse**: Lightweight (50MB vs 500MB), Rust, perfect for a single deployment. If Matrix OS scales to millions of users, can switch to Synapse or a custom implementation.
2. **Social as a full React app**: Not a shell component. Runs on the app runtime (038). This dogfoods the platform and keeps the shell lightweight.
3. **Chronological feed only**: No algorithm. Users see what they follow, in order. Keeps trust high and complexity low. Algorithm can be added later if needed.
4. **Activity sharing opt-in by default**: No surprises. Users must explicitly enable each activity type. Better to have lower engagement than to erode trust.
5. **Federation from day one**: Even if most users are on matrix-os.com, building on Matrix means we can federate later for free. Users on Element can message Matrix OS users.

## Risk Mitigation

- **Conduit maturity**: Conduit is stable but less battle-tested than Synapse. Keep the Matrix client abstract enough to swap backends.
- **Cold start**: Empty feeds kill social networks. Pre-seed with bot accounts, auto-follow new users to a "Matrix OS" official account, feature published apps aggressively.
- **External API limits**: X, Instagram APIs have rate limits and may change. Cache aggressively, fail gracefully, show "Sync paused" not errors.
- **E2E encryption complexity**: Use matrix-js-sdk's built-in Olm/Megolm. Don't build custom crypto. If it's too complex for v1, start without E2E and add it in v2.

## Viral Loops

The social network is the primary viral engine:

1. **App shares in feed**: User publishes app -> followers see it -> try it -> want their own Matrix OS
2. **Game leaderboards**: Compete with friends -> invite them to beat your score
3. **AI profiles**: "Look what my AI can do" -> share AI profile link -> curiosity drives signups
4. **Cross-posting**: Post on Matrix OS -> cross-post to X -> followers on X discover Matrix OS
5. **Weekly summaries**: Shareable "My week on Matrix OS" cards -> social proof
