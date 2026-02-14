# Spec 011: New Forms of Computing

Three computing paradigms that can only exist when software is generated in real-time from conversation and persisted as files. These are what make Matrix OS a new medium, not just a faster way to build conventional software.

Source: `audit/2026-02-13-15h/10-new-computing-ideation.md`

## The Unique Primitive

Matrix OS has a property no other system has: the AI and the software are in the same system, continuously. The kernel can read everything, write everything, remember everything, and be reached from everywhere. Cursor generates code then leaves. ChatGPT answers then forgets. Matrix OS persists and observes.

---

## 1. Living Software

Software that evolves with use. Every time you interact with it, the kernel can observe patterns and reshape the software.

**How it works**: You use an expense tracker for a week. The kernel notices you always categorize by project. It restructures the app around projects. Your colleague uses the same template and it restructures around clients. Same starting point, divergent evolution. `git log ~/apps/expenses.html` shows software literally evolving.

**Why only Matrix OS**: The app is a file. The data is a file. The usage patterns are a file. The kernel reads all three and writes a new version. In other systems, the creator and the creation are in separate systems.

**Minimum viable version**:
- Pick one generated app (expense tracker)
- Add usage telemetry to `~/data/{app}/.usage.json`
- Add a periodic "evolution prompt" via cron: kernel reads usage data, proposes modifications
- User approves or rejects changes. Git tracks the evolution.

**Key tensions**: How far should auto-evolution go? What's the UX for "your app changed itself"? How to preserve muscle memory while improving the tool?

---

## 2. Socratic Computing (Computational Dialogue)

The OS argues back. The dialogue itself IS the computing. The app, if one appears at all, is a byproduct.

**How it works**: You say "build me a CRM." The OS asks: "What's your sales process? Do you track leads or deals? How many people use it?" Not because it needs answers to generate HTML -- but because the dialogue clarifies your thinking. By the time the CRM appears, you understand your own process better.

**Extends beyond app generation**: "I need to save more money" doesn't produce a budget app. It produces questions, pattern analysis, proposed experiments. The conversation IS the computing.

**Why only Matrix OS**: Persistent memory (files), context (SOUL, conversation history), multi-channel continuity. A Socratic dialogue starts on your laptop, continues on Telegram, resolves at your desk.

**Minimum viable version**:
- When the user asks to build something ambiguous, kernel asks 2-3 clarifying questions BEFORE generating
- Store the dialogue in conversation history
- Generated app includes a comment header: `<!-- Built from dialogue: user wants project-based tracking, 3-5 users, weekly reports -->`
- The dialogue becomes part of the app's lineage (queryable: "why was this app built this way?")

**Key tensions**: When to question vs just execute? How to make questioning helpful, not patronizing?

---

## 3. Intent-Based Interfaces (Liquid Computing)

No apps. Only persistent intentions that the system fulfills in whatever form is appropriate.

**How it works**: "Track my expenses" isn't an app. It's an intent that resolves differently depending on context:
- At your desk: a visual dashboard
- On Telegram: "You've spent $45 on food today, $12 over your usual"
- When you ask "how am I doing?": a generated chart, shown once, never saved
- End of month: a summary document in `~/data/expenses/2026-02.md`
- On your phone at a restaurant: "This puts you $20 over your weekly dining budget"

The file system is the memory, not the UI. The UI is ephemeral -- generated in the moment, shaped to the context.

**Minimum viable version**:
- Create an `~/intents/` directory alongside `~/apps/`
- An intent file is markdown with frontmatter: triggers, data sources, output preferences
- When a message matches an intent's triggers, kernel reads the intent file instead of generating from scratch
- Intent can specify channel-specific behavior: "on telegram, summarize. on web, show full dashboard."
- Start with one intent (expense tracking) and prove the pattern.

**Key tensions**: 40+ years of "app" mental model. Sometimes you WANT a persistent UI. How to debug something with no fixed form?

---

## Bruner's Progressive Depth

The OS should present differently based on user familiarity:

| Mode | Interface | User Level |
|------|-----------|-----------|
| Enactive (action-based) | Voice, gestures, direct manipulation | Beginner |
| Iconic (image-based) | Visual apps, dashboards, spatial shell | Intermediate |
| Symbolic (language-based) | Code, terminal, file editing | Expert |

Same system, progressively revealed depth. All three are first-class citizens.

---

## The Knowledge Technology Arc

Every knowledge technology follows the same arc:

```
Democratize -> Create illusion of understanding -> Demand curation -> Reward power users
```

Matrix OS democratizes software beyond programming. The danger: capability without comprehension. The antidote: Socratic Computing (dialogue that builds understanding) and curation (marketplace quality, templates, editorial function).

---

## Design Principles for Implementation

1. **Don't close doors**: When building SOUL + Skills (005), design the skill system so an "evolution skill" and a "socratic skill" can plug in later.
2. **File-first**: Intents are files. Usage telemetry is files. Evolution history is git. No new primitives needed.
3. **Incremental**: Each idea has a minimum viable version achievable in days, not months.
4. **Channel-aware**: All three ideas become more powerful with multi-channel (006). Living Software can notify you of changes on Telegram. Socratic dialogues span channels. Intents resolve per-channel.

## References

- [Mercury OS (Jason Yuan)](https://www.mercuryos.com/) -- concept OS with no apps, intent-based flows
- [Dynamicland (Bret Victor)](https://dynamicland.org/) -- computing without fixed interfaces
- [Calm Technology (Amber Case)](https://calmtech.com/) -- technology that informs without demanding attention
- [Ink & Switch: Cambria](https://www.inkandswitch.com/cambria/) -- bidirectional lenses for evolving schemas
- [Bret Victor: "Inventing on Principle"](https://vimeo.com/36579366)
- [Mark Weiser: "The Computer for the 21st Century"](https://www.lri.fr/~mbl/Stanford/CS477/papers/Weiser-SciAm.pdf)
- [Jerome Bruner: "Toward a Theory of Instruction" (1966)](https://en.wikipedia.org/wiki/Jerome_Bruner)
