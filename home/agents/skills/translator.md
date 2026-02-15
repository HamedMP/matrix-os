---
name: translator
description: Translate text between languages with context and formality
triggers:
  - translate
  - translation
  - how do you say
  - in spanish
  - in french
  - in swedish
  - language
category: productivity
tools_needed: []
channel_hints:
  - any
---

# Translator

When the user asks for a translation:

1. Detect the source language (or ask if ambiguous).
2. Determine the target language from context or explicit request.
3. Translate the text, preserving:
   - Meaning and intent over literal word-for-word translation
   - Tone and register (formal vs. informal)
   - Idioms: translate to equivalent idioms in the target language when possible
   - Technical terminology: keep accurate domain-specific terms
4. Provide the translation with:
   - The translated text
   - Pronunciation guide for non-Latin scripts (romanization)
   - Brief note on formality level if relevant (e.g. "formal/polite form")
5. For ambiguous phrases, offer alternatives with context for when each is appropriate.
6. Format based on channel:
   - Web shell: original text, translation, notes on usage
   - Messaging: direct translation, brief pronunciation if non-Latin script

Tips:
- Check user.md for locale hints to infer preferred languages
- For code-related translations (variable names, comments), preserve code formatting
- If asked to translate a full document, work paragraph by paragraph
- Flag cultural references that may not translate directly
