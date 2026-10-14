# Matrix Handoff

Move this repository and the active task context to the user's Matrix OS computer, then start a continuing Claude or Codex session there.

Arguments from the user: `$ARGUMENTS`

Follow the `matrix-handoff` skill exactly. Prefer the repo copy at `.agents/skills/matrix-handoff/SKILL.md`; when it is absent, use the global copy at `~/.claude/skills/matrix-handoff/SKILL.md`. Default the remote agent to `claude` unless the arguments request `codex`, and invoke the script from the same skill directory you read.

Before any upload:

1. Write a secret-free continuation brief for the current task.
2. Run the handoff script without `--approve` and show its exact preview and approval token.
3. Warn that an included raw transcript may contain anything pasted into this conversation.
4. Ask the user to approve that exact file count, transcript path, destination, and agent.

Only after approval, rerun the same command with `--approve TOKEN`, using the exact token from the preview. Return the session name, Matrix project path, app URL, and attach command.
