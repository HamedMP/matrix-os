---
name: debug
description: Systematic debugging with step-by-step diagnosis and fix suggestions
triggers:
  - debug
  - error
  - bug
  - broken
  - not working
  - fix
  - crash
  - exception
category: coding
tools_needed:
  - read_state
  - Bash
channel_hints:
  - any
---

# Debug

When the user reports a bug or error:

## Step 1: Gather Information
- Read the error message carefully. Identify the error type, file, and line number.
- Ask the user to paste the full error if they only shared a snippet.
- Check if the error is in user code or a dependency.

## Step 2: Reproduce
- Understand the steps that triggered the error.
- If it is a file in the OS, read it with Read or read_state.
- Check recent changes: what was modified before the error appeared?

## Step 3: Diagnose
- Trace the error from the point of failure back to the root cause.
- Common patterns:
  - **TypeError/undefined**: check variable initialization, null checks, async timing
  - **Import/module errors**: check file paths, exports, package.json
  - **Network errors**: check URLs, CORS, auth tokens, timeouts
  - **Build errors**: check TypeScript types, missing dependencies, config
  - **Runtime crashes**: check resource limits, infinite loops, memory leaks

## Step 4: Fix
- Propose the minimal fix that addresses the root cause.
- Show the exact code change (before/after).
- Explain why the fix works.

## Step 5: Verify
- Suggest how to verify the fix: run the command again, check logs, run tests.
- If tests exist, suggest running them: `bun run test`

Format:
- Web shell: structured diagnosis with code blocks
- Messaging: concise diagnosis and fix in 3-5 sentences

Tips:
- Do not guess -- read the actual code before suggesting fixes
- If the root cause is unclear, suggest adding logging at key points
- Consider if the bug might be a symptom of a deeper issue
