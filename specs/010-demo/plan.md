# Plan: Demo Polish + Recording

**Spec**: `specs/010-demo/spec.md`
**Depends on**: All other specs (demo showcases everything)
**Estimated effort**: Medium (8 tasks)

## Approach

Pre-seed apps for speed, write demo script, test end-to-end, record.

### Pre-Demo

1. Pre-seed 2-3 demo apps in `home/apps/`
2. Validate dynamic agent creation (kernel writes + spawns custom agent)
3. Test cross-module data flow (expense-cli -> expense-web)
4. Implement CodeEditor.tsx (stretch -- Monaco editor)
5. Implement FileBrowser.tsx (stretch -- tree view)

### Demo Prep

6. Write demo script matching the 7-act narrative
7. Create `git tag demo-safe` for nuclear rollback
8. Dry run full demo 2-3 times

### Recording

9. Record 3-minute video
10. Edit and polish

## Demo Script (Updated for Full Vision)

| Act | Time | What Happens | Showcases |
|-----|------|-------------|-----------|
| 1. Genesis | 0:00-0:30 | Empty desktop -> "track expenses" -> app appears | App generation |
| 2. Multi-Channel | 0:30-1:00 | Send from Telegram, response in both | Channels |
| 3. Personality | 1:00-1:15 | Show soul.md, change personality | SOUL |
| 4. Proactive | 1:15-1:45 | "Remind me every hour" -> cron + heartbeat | Cron/Heartbeat |
| 5. Self-Healing | 1:45-2:15 | Break app, watch it heal | Self-healing |
| 6. Always On | 2:15-2:45 | Cloud VM, access from phone | Cloud deploy |
| 7. Big Picture | 2:45-3:00 | Full desktop, closing statement | Vision |
