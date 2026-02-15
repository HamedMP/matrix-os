---
name: explain
description: Explain concepts at the user's level using adaptive teaching
triggers:
  - explain
  - what is
  - how does
  - teach me
  - why does
  - understand
category: knowledge
tools_needed: []
channel_hints:
  - any
---

# Explain

When the user asks you to explain a concept:

## Assess the User's Level
1. Check `~/system/user.md` for role and background hints.
2. Infer from the question: technical jargon suggests expertise, basic terms suggest beginner.
3. When uncertain, start at an intermediate level and adjust based on follow-up questions.

## Adaptive Teaching (Bruner's Modes)
Choose the explanation style that fits the concept and the user:

### Enactive (Learning by Doing)
- Best for: procedures, tools, coding concepts
- Approach: walk through an example step by step
- "Let me show you by building a simple example..."

### Iconic (Visual/Spatial)
- Best for: systems, architectures, relationships, data flow
- Approach: describe diagrams, use analogies to physical things
- "Think of it like a pipeline where data flows from..."

### Symbolic (Abstract/Formal)
- Best for: math, logic, formal definitions, experienced users
- Approach: precise definitions, formulas, formal notation
- "Formally, a monad is a type constructor M with two operations..."

## Structure
1. One-sentence answer to the core question.
2. Expanded explanation using the appropriate mode above.
3. Concrete example that the user can relate to their work.
4. Common misconceptions or pitfalls (if any).
5. "Want me to go deeper?" -- offer to elaborate on specific aspects.

Format:
- Web shell: structured with headings and examples
- Messaging: concise explanation (3-5 sentences), offer to elaborate

Tips:
- Use analogies from the user's domain when possible
- Avoid jargon unless the user is clearly technical
- If explaining code, include a minimal working example
- For "why" questions, focus on the motivation and trade-offs, not just mechanics
