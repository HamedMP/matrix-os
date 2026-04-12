---
name: code-review
description: Review code for bugs, style issues, and security vulnerabilities
triggers:
  - review
  - code review
  - check my code
  - audit
  - lint
category: coding
tools_needed:
  - read_state
channel_hints:
  - web
---

# Code Review

When the user asks for a code review:

1. Read the file(s) to review using Read or read_state.
2. Analyze the code for:
   - **Bugs**: logic errors, off-by-one, null/undefined access, race conditions
   - **Security**: injection vulnerabilities (SQL, XSS, command), hardcoded secrets, insecure defaults
   - **Style**: naming conventions, dead code, overly complex expressions, missing error handling
   - **Performance**: unnecessary allocations, N+1 queries, missing memoization, large bundle concerns
   - **TypeScript**: type safety issues, any casts, missing generics
3. Structure the review as:
   - Summary: one-sentence overall assessment
   - Issues: ordered by severity (critical, warning, suggestion)
   - Each issue: file:line, description, suggested fix
4. For each issue, provide a concrete code suggestion when possible.
5. End with what the code does well -- balanced feedback.

Format:
- Web shell: structured Markdown with code blocks for suggestions
- Messaging: top 3 most important findings only

Tips:
- Focus on what matters: security and correctness over style preferences
- If the code is in a language you can identify, apply that language's conventions
- For large files, focus review on the most complex or changed sections
- Do not suggest changes purely for aesthetic reasons unless they improve readability significantly
