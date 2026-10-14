# Matrix Handoff

Move this repository and the active task to the user's Matrix computer as a project Chat.

Arguments from the user: `$ARGUMENTS`

Follow the `matrix-handoff` skill exactly. Use `.agents/skills/matrix-handoff/SKILL.md` in this repository, or the installed Matrix OS plugin skill when that file is absent. Default the agent to `claude` unless the arguments ask for `codex`.

Before anything is uploaded:

1. Write a continuation brief for the current task, with no secrets in it.
2. Run `matrix handoff --agent <agent> --brief <file>` and show the user its exact preview.
3. If a transcript is listed, warn the user that it may contain anything pasted into this conversation.
4. Ask the user to approve that exact project action, branch, set of changes, transcript and agent.

Only after the user approves, run the exact command the preview printed, ending in `--approve TOKEN`. Then report the Chat link, the project and the branch.
