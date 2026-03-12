# Plan: App Store + Publishing

**Spec**: spec.md
**Tasks**: tasks.md

## Execution Order

```
Phase A: Registry (T1470-T1474)           -- database, API, storage (foundation)
  |
  +---> Phase B: Publishing (T1475-T1479) -- depends on registry API
  |
  +---> Phase D: Store UI (T1485-T1489)   -- depends on registry API
  |
  +---> Phase C: Fork/Clone (T1480-T1482) -- depends on registry for source
  |
Phase E: Personal Websites (T1490-T1494)  -- depends on platform routing, can start after A

```

## Phase Breakdown

### Week 1: Registry Foundation
- Database schema + migrations (T1470)
- CRUD API endpoints (T1471)
- S3 file storage for app files (T1472)
- Seed with pre-bundled apps from 038

### Week 2: Publishing + Store UI (parallel)
- **Stream 1**: publish_app IPC tool + AI publishing skill (T1475-T1477)
- **Stream 2**: Store shell component + app detail page (T1485-T1486)

### Week 3: Public URLs + Fork
- Public app runner (T1487-T1488) -- the viral mechanic
- Fork/clone system (T1480-T1482)

### Week 4: Personal Websites
- Subdomain routing (T1490)
- Profile app template (T1491-T1492)
- Custom domain support (T1493)

## Key Decisions

1. **S3 for app storage**: Apps published to central S3, downloaded to user's OS on install. Platform doesn't run the app -- user's container does.
2. **Anonymous sandbox for public apps**: Temporary data only. Creates signup pressure without blocking the experience.
3. **Profile app is a real app**: Not a hardcoded template. User can modify it via chat. This dogfoods the entire app system.
4. **Install vs Fork**: Install = read-only copy for use. Fork = writable copy for modification. Both download the files.

## Risk Mitigation

- **Spam/abuse**: Rate limit publishes (10/day). Auto-scan for malicious patterns. Report button on store pages.
- **Storage costs**: S3 is cheap per GB. Set per-app size limit (50MB). Monitor total storage per user.
- **SEO for store pages**: Server-render store pages in www/ (Next.js). Each app gets a shareable Open Graph preview.
