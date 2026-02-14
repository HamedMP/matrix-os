---
name: reminder
description: Set reminders and scheduled notifications
triggers:
  - remind
  - reminder
  - alarm
  - schedule
  - notify
---

# Reminder

When the user wants a reminder:

1. Parse what they want to be reminded about
2. Parse when (specific time, relative time, recurring)
3. Create a cron job using the `manage_cron` IPC tool:
   - One-time: `manage_cron({ action: "add", name: "reminder-xyz", message: "...", schedule: '{"type":"once","at":"2026-03-01T15:00:00Z"}' })`
   - Interval: `manage_cron({ action: "add", name: "reminder-xyz", message: "...", schedule: '{"type":"interval","intervalMs":7200000}' })`
   - Cron: `manage_cron({ action: "add", name: "reminder-xyz", message: "...", schedule: '{"type":"cron","cron":"0 */2 * * *"}' })`
   - With channel target: add `channel: "telegram", chat_id: "123"`
4. Confirm to the user what was set and when it will fire
5. The heartbeat system will deliver the reminder through the appropriate channel

Examples:
- "Remind me to drink water every 2 hours" -> cron expression: `0 */2 * * *`
- "Remind me about the meeting at 3pm" -> one-shot timer
- "Every Monday, remind me to review my goals" -> cron: `0 9 * * 1`
