---
name: study-timer
description: Pomodoro study timer with focus sessions and break reminders
triggers:
  - study
  - pomodoro
  - focus
  - timer
  - study session
---

# Study Timer

When the user wants to start a study session:

1. Ask what they're studying (or use context from conversation)
2. Set up a Pomodoro cycle using `manage_cron`:
   - 25 minutes focus, then "Time for a 5-minute break!"
   - After 4 cycles, "Great work! Take a 15-minute break."
3. Create the focus timer:
   - `manage_cron({ action: "add", name: "study-break", message: "Focus session done! Take a 5-minute break.", schedule: '{"type":"once","at":"...25min from now..."}' })`
4. Log the study session to `~/data/study-log/sessions.json`
5. Track total study time across sessions

Commands:
- "Start studying [topic]" -> begin 25-min Pomodoro
- "How much have I studied today?" -> read study-log
- "Stop studying" -> cancel active timers via `manage_cron({ action: "remove", ... })`
