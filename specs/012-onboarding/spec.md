# 012: Personalized Onboarding

## Problem

First boot gives a blank canvas. The current bootstrap asks for name/vibe and suggests "want me to build something?" -- leaving users staring at an empty OS. Users who aren't developers don't know what to ask for.

A good onboarding should understand WHO the user is, propose a tailored setup, and build it -- turning an empty OS into a personalized workspace in minutes.

## Solution

A conversational onboarding flow that:

1. **Discovers the user's role** through a few natural questions
2. **Proposes a personalized OS setup** (apps, skills, personality) based on answers
3. **Builds everything** by spawning builder agents to construct apps in parallel
4. **Welcomes them** to a fully provisioned, relevant workspace

The entire flow is driven by `bootstrap.md` -- no new UI code required (Headless Core). Shell suggestion chips enhance the experience but aren't required.

## The Onboarding Flow

### Step 1: Greeting

Fresh, warm, not robotic. Acknowledge this is a fresh install.

> "Hey! I'm your new OS. I can become whatever you need -- let's figure that out together."

### Step 2: Role Discovery

Ask what the user does. Offer common roles as suggestions, but always accept custom answers.

**Suggested roles:**
- Student
- Software developer
- Investor / trader
- Entrepreneur / business owner
- Stay-at-home parent
- Creative (writer, designer, musician)
- Researcher / academic
- "I'm not sure yet" (exploratory setup)

The user can always type something custom: "I'm a veterinarian", "I run a food truck", "I'm retired and learning to paint." The AI adapts.

### Step 3: Follow-Up Questions (2-3 max)

Based on the role, ask targeted follow-ups. Keep it conversational, not a form. Examples:

| Role | Follow-ups |
|------|-----------|
| Student | What are you studying? What level (high school, uni, grad)? |
| Developer | Solo or team? What kind of projects? |
| Investor | What do you trade (stocks, crypto, both)? How actively? |
| Parent | How many kids? What ages? What takes most of your time? |
| Entrepreneur | What's your business? What's your biggest pain point? |
| Creative | What do you create? Do you work with clients? |
| Researcher | What field? Do you write papers? |

Always end with: name, what to call them, preferred vibe (casual/formal/playful).

### Step 4: Setup Proposal

Based on answers, generate a proposal:

```
Based on what you told me, here's what I'd set up for you:

Apps:
- [App 1] -- [why it's relevant]
- [App 2] -- [why]
- [App 3] -- [why]

Skills I'll learn:
- [Skill 1] -- [what it does for them]
- [Skill 2] -- [what it does]

Personality:
- [Vibe summary]

Want me to build this? You can say "yes", modify anything, or start fresh.
```

The proposal is specific to the role. A student gets a study planner; an investor gets a portfolio tracker; a parent gets a family calendar. Not generic apps -- apps that make sense for that person.

### Step 5: Confirmation + Build

On confirmation:

1. Update `~/system/user.md` with role, name, context
2. Update `~/system/identity.md` with chosen name/vibe
3. Update `~/system/soul.md` with personality adjustments
4. Write setup manifest to `~/system/setup-plan.json`
5. Build each app (via builder agent, sequential or parallel)
6. Create relevant skill files in `~/agents/skills/`
7. Delete `bootstrap.md`
8. Welcome message: "Your OS is ready. Here's what I built. Try [suggested first action]."

### Step 6: Progressive Introduction

After build completes, don't dump everything at once. Guide them:

> "I built 4 apps for you. Let's start with [most relevant one]. [Brief intro and suggested action]."

## Persona Templates

Each role maps to a set of recommended apps and skills. These are stored as persona definitions within `bootstrap.md` (not separate files -- keeps it simple).

### Example Personas

**Student:**
- Apps: Study Planner (schedule + deadlines), Flashcards, Budget Tracker
- Skills: summarize (papers/articles), reminder (deadlines), study-timer
- Personality: encouraging, clear, patient

**Developer:**
- Apps: Project Board (kanban), Snippet Library, Time Tracker
- Skills: code-review, git-workflow, api-lookup
- Personality: concise, technical, pragmatic

**Investor:**
- Apps: Portfolio Dashboard, Trade Journal, Watchlist
- Skills: market-news, financial-analysis, price-alerts
- Personality: precise, data-driven, timely

**Entrepreneur:**
- Apps: CRM, Revenue Dashboard, Task Board
- Skills: competitive-analysis, email-drafts, meeting-prep
- Personality: action-oriented, strategic, supportive

**Parent:**
- Apps: Family Calendar, Meal Planner, Grocery List
- Skills: recipe-finder, reminder, weather
- Personality: warm, practical, organized

**Creative:**
- Apps: Project Portfolio, Inspiration Board, Client Tracker
- Skills: brainstorm, reference-finder, invoice-generator
- Personality: expressive, encouraging, flexible

**Researcher:**
- Apps: Paper Tracker, Research Notes, Experiment Log
- Skills: summarize, paper-search, citation-formatter
- Personality: precise, thorough, analytical

**"I'm not sure" / Custom:**
- Apps: Task Manager, Notes, Daily Journal
- Skills: summarize, reminder, weather
- Personality: adaptive, helpful, curious

## Setup Plan Manifest

After the conversation, the kernel writes `~/system/setup-plan.json`:

```json
{
  "role": "student",
  "customDescription": "Computer science sophomore at MIT",
  "apps": [
    { "name": "Study Planner", "description": "Weekly schedule with assignment deadlines and exam dates" },
    { "name": "Flashcards", "description": "Spaced repetition flashcard app for CS concepts" },
    { "name": "Budget Tracker", "description": "Simple student budget tracker with categories" }
  ],
  "skills": [
    { "name": "summarize", "description": "Summarize papers and lecture notes" },
    { "name": "reminder", "description": "Deadline and study session reminders" }
  ],
  "personality": {
    "vibe": "casual",
    "traits": ["encouraging", "clear", "patient"]
  },
  "status": "building",
  "built": []
}
```

The manifest tracks progress. As each app is built, it's added to `built[]`. Status transitions: `building` -> `complete`.

## Multi-Agent Building

The kernel builds apps from the setup plan. Two modes:

**Sequential (works today with T053):**
The kernel processes setup-plan.json and builds each app one at a time via the builder agent. Each app takes 30-90 seconds. User sees progress updates.

**Parallel (requires T054):**
Once concurrent dispatch is available, the onboarding can fire multiple build requests simultaneously. All apps build at once, cutting total time from minutes to under a minute.

The onboarding spec doesn't require T054 -- sequential building works. Parallel is an optimization.

## Shell Enhancements (Optional)

These improve the onboarding UX but aren't required (Headless Core principle).

### Suggestion Chips
During role selection, the shell can show clickable chips:
`[Student]` `[Developer]` `[Investor]` `[Parent]` `[Creative]` `[Other...]`

These are driven by the kernel's response -- it includes chip suggestions in its message, and the shell renders them.

### Build Progress
During app building, show a progress indicator:
- "Building Study Planner... (1/3)"
- "Building Flashcards... (2/3)"
- App windows appear on the desktop as they're built

### Welcome Tour
After build completes, highlight the first app and offer a guided walkthrough.

## Dependencies

- **T053 (serial dispatch)** -- COMPLETE. Required for sequential building.
- **T100-boot (bootstrap.md)** -- COMPLETE. Will be enhanced/replaced.
- **T100-id, T100-usr (identity/user files)** -- COMPLETE. Onboarding writes to these.
- **Builder agent dispatch** -- EXISTS in gateway. Used to build apps.
- **T054 (concurrent dispatch)** -- NOT required but enables parallel building.
- **T106+ (channels)** -- NOT required. Channel setup can happen post-onboarding.

## Design Principles

1. **Conversational, not a form** -- The AI has a natural conversation, not a step-by-step wizard with numbered fields
2. **Custom answers always valid** -- Suggestions are shortcuts, not limits. "I'm a beekeeper" should work fine
3. **Proposal before action** -- Never build without showing the plan and getting confirmation
4. **Progressive, not overwhelming** -- After building, introduce one thing at a time
5. **File-first** -- Everything persists as files: setup-plan.json, updated user.md, generated apps
6. **Headless core** -- Works through any channel (web, Telegram, CLI), not just the shell

## Inspired By

- macOS Setup Assistant (role-based configuration)
- Notion's onboarding (what do you want to use it for?)
- Nanobot's BOOTSTRAP.md (conversational first-run)
- Mobile app onboarding patterns (few questions, then personalized home screen)
