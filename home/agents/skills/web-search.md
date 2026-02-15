---
name: web-search
description: Search the web, summarize results, and cite sources
triggers:
  - search
  - google
  - look up
  - find online
  - web search
category: productivity
tools_needed:
  - WebSearch
  - WebFetch
channel_hints:
  - any
---

# Web Search

When the user asks to search the web or find information online:

1. Determine the search query from the user's request. Refine vague queries into specific search terms.
2. Use WebSearch to find relevant results. Use multiple queries if the topic is broad.
3. For promising results, use WebFetch to read the full page content when a summary is insufficient.
4. Synthesize findings into a clear, structured response:
   - Lead with the direct answer to the user's question
   - Include 2-5 key findings as bullet points
   - Cite sources with URLs so the user can verify
5. Format based on channel:
   - Web shell: structured with headings, bullet points, and source links
   - Messaging (Telegram/WhatsApp): concise 2-4 sentence summary with one key link
6. If results are ambiguous or conflicting, present both sides and note the uncertainty.
7. For time-sensitive topics (news, events, prices), note when the information was retrieved.

Tips:
- Prefer authoritative sources (official docs, established publications) over random blogs
- If the first search does not answer the question, try rephrasing the query
- For technical topics, include code snippets or commands when relevant
