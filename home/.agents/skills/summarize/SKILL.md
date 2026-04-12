---
name: summarize
description: Summarize text, articles, conversations, or documents
triggers:
  - summarize
  - tldr
  - summary
  - brief
---

# Summarize

When asked to summarize content:

1. Identify the source: pasted text, URL, or file path
2. If URL: use WebSearch or Read to fetch content
3. If file path: use Read to load the file
4. Extract key points, main arguments, and conclusions
5. Format based on channel:
   - Web shell: structured summary with bullet points
   - Messaging (Telegram/WhatsApp): 2-3 sentence TLDR
6. Include source attribution when available
7. If content is very long, summarize in layers: executive summary first, then details if asked
