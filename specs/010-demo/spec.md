# 010: Demo Polish + Recording

## Problem

Need a compelling 3-minute hackathon demo that showcases both the visual OS and the personal assistant capabilities. Raw generation takes 30-90s per app -- too slow for a demo.

## Solution

Pre-seed demo apps for instant showcase, write a demo script covering all key capabilities, record.

## Deliverables

### Pre-seeded Apps
- 2-3 demo apps in `home/apps/` (expense tracker, notes, dashboard)
- Pre-built so demo doesn't wait for generation

### Shell Components (stretch)
- `CodeEditor.tsx` -- Monaco editor for viewing/editing any file
- `FileBrowser.tsx` -- tree view of the file system

### Demo Script (3 minutes)

**Act 1: Genesis (0:00 - 0:30)**
- Clean desktop. "I need to track my daily expenses"
- App appears (pre-seeded, fast). Show it's functional.

**Act 2: Multi-Channel (0:30 - 1:00)**
- Send message from Telegram: "What modules are running?"
- OS responds in Telegram. Same conversation visible in web shell.

**Act 3: Personality (1:00 - 1:15)**
- Show soul.md. "Be more playful" -> personality changes.
- "What skills do you have?" -> lists available skills.

**Act 4: Proactive (1:15 - 1:45)**
- "Remind me to stretch every hour"
- Cron job created. Show cron.json.
- Heartbeat fires -> sends reminder to Telegram.

**Act 5: Self-Healing (1:45 - 2:15)**
- Break an app. Health check detects. Healer fixes it.

**Act 6: Always On (2:15 - 2:45)**
- Show it running on cloud VM.
- Access from phone browser. Same OS, same state.

**Act 7: The Big Picture (2:45 - 3:00)**
- Full desktop. "This started as an empty canvas."
- "Matrix OS -- the operating system that builds itself."

### Recording
- `git tag demo-safe` before recording
- Record with screen capture
- Test cross-module data flow (expense-cli -> expense-web)

## Dependencies

- All other specs should be substantially complete
- Channel (at least Telegram) working
- Cloud deployment working
- SOUL + Skills working
