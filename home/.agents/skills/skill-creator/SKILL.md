---
name: skill-creator
description: Create new skills by writing skill files
triggers:
  - learn
  - new skill
  - teach
  - create skill
---

# Skill Creator (Meta-Skill)

When the user wants you to learn something new or create a new capability:

1. Understand what the new skill should do
2. Ask clarifying questions if needed (what triggers it? what's the expected behavior?)
3. Create a new skill file at `~/agents/skills/<name>.md` with this format:

```markdown
---
name: <skill-name>
description: <one-line description>
triggers:
  - <keyword1>
  - <keyword2>
---

# <Skill Name>

<Instructions for how to perform this skill>
```

4. The skill will be available on the next interaction (skills are loaded on each prompt build)
5. Confirm to the user that the skill was created and what triggers it

Guidelines:
- Keep skill names lowercase, hyphenated (e.g., `github-stars`)
- Keep descriptions under 80 characters
- Include 2-5 trigger keywords
- Write clear, step-by-step instructions in the body
- Reference IPC tools, WebSearch, or file operations as needed
