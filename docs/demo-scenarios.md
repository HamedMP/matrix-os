# Demo Scenarios

Testable user stories for demos and smoke testing. Each scenario includes the user action, expected kernel behavior, and how to verify.

Prerequisites: `bun run dev` (gateway on :4000, shell on :3000), `ANTHROPIC_API_KEY` set.

---

## 1. Fresh Install Onboarding

**Setup**: `rm -rf ~/matrixos && bun run dev:gateway`

**User**: Opens shell, types anything (e.g. "hey")

**Expected**:
- Kernel detects `bootstrap.md` and starts onboarding conversation
- Asks who you are (role: student, developer, investor, etc.)
- 2-3 follow-up questions based on role
- Proposes personalized apps + skills + personality
- On confirmation: writes `user.md`, `soul.md`, `identity.md`, `setup-plan.json`
- Builds each app sequentially
- Deletes `bootstrap.md` when done

**Verify**:
```bash
ls ~/matrixos/apps/
cat ~/matrixos/system/setup-plan.json
cat ~/matrixos/system/user.md
test ! -f ~/matrixos/system/bootstrap.md && echo "bootstrap cleaned up"
```

---

## 2. Cron Reminders

**User**: "Set a reminder to drink water every hour"

**Expected**:
- Kernel calls `manage_cron` IPC tool with action "add"
- Creates a cron job with hourly interval schedule
- Confirms with job name and schedule details

**Verify**:
```bash
cat ~/matrixos/system/cron.json
# Should contain entry with name, message, and schedule
```

**Variations**:
- "Remind me to stand up every 30 minutes"
- "Send me a daily standup prompt at 9am" (cron expression)
- "Remind me to call mom on March 1st at 6pm" (one-shot)
- "List my reminders" / "Remove the water reminder"

---

## 3. Skill-Driven Interactions

**User**: "Help me track my expenses"

**Expected**:
- Kernel matches to `budget-helper` skill
- Calls `load_skill` to load full instructions
- Follows skill flow: creates expense tracker app with categories, weekly digest cron job

**Verify**:
```bash
ls ~/matrixos/apps/
cat ~/matrixos/system/cron.json  # weekly digest job
```

**Other skills**:
- "I need a study timer" -> `study-timer` skill (Pomodoro app)
- "Summarize this article: [url]" -> `summarize` skill
- "What's the weather?" -> `weather` skill

---

## 4. App Building

**User**: "Build me a todo app"

**Expected**:
- Kernel uses builder agent to generate app files
- Creates `~/apps/todo/` with HTML/CSS/JS
- Registers in `~/system/modules.json`
- App appears in shell dock and is viewable in iframe

**Verify**:
```bash
ls ~/matrixos/apps/todo/
cat ~/matrixos/system/modules.json
```

**Variations**:
- "Build me a habit tracker with streaks"
- "Make a recipe book app"
- "Build a countdown timer to my birthday (June 15)"

---

## 5. Handle Setup (First Boot Identity)

**User**: On fresh install or when handle is empty, chat anything

**Expected**:
- If during bootstrap: kernel asks for handle as part of onboarding conversation
- If after bootstrap: kernel notices empty handle and prompts to set one
- Kernel calls `set_handle` tool with chosen handle and display name
- Handle saved to `~/system/handle.json`

**Verify**:
```bash
cat ~/matrixos/system/handle.json
# Should contain: handle, aiHandle, displayName, createdAt
```

---

## 6. Git Sync

**User**: "Sync my files to GitHub" or "Add a backup remote"

**Expected** (once T222 kernel support is wired):
- Kernel calls git sync operations to push/pull
- Auto-sync debounces file changes (30s) and commits automatically
- `.gitignore` excludes logs, sqlite, whatsapp-auth, large media

**Verify**:
```bash
cd ~/matrixos && git log --oneline -5   # auto-sync commits
cat ~/matrixos/.gitignore               # exclusion patterns
git remote -v                           # configured remotes
```

---

## 7. Identity and Profiles

**User**: Check profile endpoints

**Verify**:
```bash
curl http://localhost:4000/api/profile       # human profile markdown
curl http://localhost:4000/api/ai-profile    # AI profile markdown
curl http://localhost:4000/api/system/info   # version, modules, skills, cost
```

---

## 8. Observability

**User**: Chat with the kernel (any message)

**Expected**:
- Interaction logged to JSONL with timestamp, tokens, cost, duration

**Verify**:
```bash
curl "http://localhost:4000/api/logs?date=$(date +%Y-%m-%d)"
# Returns entries array + totalCost

cat ~/matrixos/system/logs/$(date +%Y-%m-%d).jsonl
```

---

## 9. Auth Middleware

**Setup**: Restart with `MATRIX_AUTH_TOKEN=demo-token bun run dev:gateway`

**Verify**:
```bash
# Rejected (401):
curl http://localhost:4000/api/system/info

# Accepted:
curl -H "Authorization: Bearer demo-token" http://localhost:4000/api/system/info

# Health always public:
curl http://localhost:4000/health
```

---

## 10. Telegram Channel

**Setup**: Edit `~/matrixos/system/config.json`, set:
```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN"
    }
  }
}
```

Restart gateway.

**User**: Message the Telegram bot

**Expected**:
- Message routed through ChannelManager to dispatcher to kernel
- Response sent back via Telegram
- Conversation visible in web shell too

**Verify**:
```bash
curl http://localhost:4000/api/channels/status
# Shows telegram: connected
```

---

## 11. Concurrent Tasks

**User** (in two browser tabs or shell + Telegram simultaneously):
- Tab 1: "Build me a CRM app"
- Tab 2: "What's 2 + 2?"

**Expected**:
- Both run concurrently (dispatcher handles parallel kernel instances)
- Quick query returns immediately while app build continues
- No file conflicts between processes

**Verify**:
```bash
curl http://localhost:4000/health
# Shows active process count
```

---

## 12. System Health

**Verify**:
```bash
curl http://localhost:4000/health
# Returns: status, uptime, activeProcesses, cronJobs, channels
```

---

## Quick Smoke Test (all-in-one)

Run these in order after a fresh `bun run dev`:

1. `curl http://localhost:4000/health` -- gateway alive
2. `curl http://localhost:4000/api/system/info` -- system info loads
3. Open `http://localhost:3000` -- shell renders
4. Chat: "Hey" -- kernel responds
5. Chat: "Set a reminder to stretch every 2 hours" -- cron job created
6. `curl "http://localhost:4000/api/logs?date=$(date +%Y-%m-%d)"` -- interaction logged
7. Chat: "Build me a notes app" -- app created in ~/apps/
