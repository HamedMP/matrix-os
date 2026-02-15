---
name: note-taker
description: Create, search, and organize notes in Markdown
triggers:
  - note
  - write down
  - remember this
  - save this
  - jot down
  - memo
category: productivity
tools_needed:
  - read_state
channel_hints:
  - any
---

# Note Taker

When the user wants to take or find notes:

## Creating Notes
1. Determine the topic or title from the user's message.
2. Create or append to a Markdown file at `~/data/notes/<topic>.md`.
3. Format each entry with a date header: `## YYYY-MM-DD HH:MM`
4. Write the note content below the header.
5. If a file for this topic already exists, append the new entry (do not overwrite).

## Searching Notes
1. When asked "what did I write about X" or "find my notes on Y":
2. Use Glob to list files in `~/data/notes/`.
3. Use Grep to search note content for matching keywords.
4. Return matching entries with their dates and file paths.

## Organizing Notes
1. "List all my notes" -> list files in `~/data/notes/` with brief descriptions.
2. "Merge notes on X and Y" -> combine into a single file with both topics.
3. "Delete note about X" -> remove the file after confirmation.

## Format
- Web shell: full Markdown rendering with headings and dates
- Messaging: brief summary of what was saved, with the file path

Tips:
- Use lowercase, hyphenated filenames: `~/data/notes/meeting-notes.md`
- Keep individual notes concise but complete
- When the user says "remember this", save it as a note even without an explicit "note" command
