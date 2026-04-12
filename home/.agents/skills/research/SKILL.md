---
name: research
description: Deep research on any topic with multi-source synthesis and structured reports
triggers:
  - research
  - deep dive
  - investigate
  - analyze
  - report on
category: knowledge
tools_needed:
  - WebSearch
  - WebFetch
channel_hints:
  - web
---

# Research

When the user asks for deep research on a topic:

## Process
1. Clarify the research scope: what specifically do they want to know? Set boundaries.
2. Search multiple sources using WebSearch with varied query formulations.
3. For key sources, use WebFetch to read full content.
4. Cross-reference findings across sources to verify accuracy.
5. Synthesize into a structured report.

## Report Structure
Save the report to `~/data/research/<topic-slug>.md`:

```
# Research: <Topic>
Date: YYYY-MM-DD

## Summary
2-3 sentence executive summary.

## Key Findings
- Finding 1 with evidence
- Finding 2 with evidence
- Finding 3 with evidence

## Details
Expanded analysis organized by subtopic.

## Sources
- [Source 1 title](url)
- [Source 2 title](url)

## Open Questions
Things that need further investigation.
```

## Quality Standards
- Minimum 3 distinct sources for any factual claim
- Note when sources disagree
- Distinguish facts from opinions
- Include dates for time-sensitive information
- Flag confidence levels: high (well-sourced), medium (limited sources), low (single source or speculation)

Format:
- Web shell: full report with Markdown formatting
- Messaging: executive summary with link to the saved report file

Tips:
- Start broad, then narrow based on initial findings
- For technical topics, prioritize official documentation and peer-reviewed sources
- For opinions or trends, include multiple perspectives
