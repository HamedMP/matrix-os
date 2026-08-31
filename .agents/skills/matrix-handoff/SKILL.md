---
name: matrix-handoff
description: Safely move the active repository and current coding-task context to the user's Matrix OS computer, then start a continuing Codex or Claude session there. Use when the user asks to continue work on Matrix, hand a local task to Matrix, upload the current project to Matrix, or move an agent conversation to another device.
---

# Matrix Handoff

Package the current working tree and a continuation brief, upload them through the authenticated Matrix CLI, and start a named remote agent session. The script deliberately excludes credentials, `.env` files, private keys, `.git`, dependencies, and build output.

## Workflow

1. Confirm `matrix` is installed. If it is not, stop and tell the user to install the Matrix CLI.
2. Write a concise continuation brief to a new temporary Markdown file outside the repository. Include:
   - the user's active goal;
   - work completed and important decisions;
   - current failures or blockers;
   - exact next actions;
   - tests or commands already run.
   Do not copy credentials, tokens, private keys, `.env` values, or unrelated conversation content into the brief.
3. Select the destination agent from the user's request. Default to the agent currently running this skill.
4. Run the preview from the repository root:

   ```bash
   node .agents/skills/matrix-handoff/scripts/matrix-handoff.mjs \
     --agent codex \
     --brief /absolute/path/to/matrix-handoff-brief.md
   ```

   Pass through user-requested options such as `--no-history`, `--history-file`, `--project-name`, or `--profile`.
5. Show the preview to the user. Explicitly identify the selected transcript path and destination. Explain that raw agent transcripts can contain anything pasted into the chat, including secrets that cannot be reliably redacted.
6. Ask for explicit confirmation before uploading. Never infer consent from the original request when a raw transcript is included; the preview is the final disclosure boundary.
7. After confirmation, rerun the identical command with `--approve TOKEN`, using the exact token printed by the preview. Do not add a broader path or a different transcript after approval.
8. Report the Matrix session name, project path, app URL, and CLI attach command printed by the script.
9. Delete the temporary continuation brief after the handoff succeeds or the user cancels.

## Options

- `--agent codex|claude`: remote agent to start.
- `--brief PATH`: agent-written continuation summary.
- `--history-file PATH`: explicit raw JSONL transcript. Use only when the preview names it and the user approves it.
- `--no-history`: summary-only handoff. Recommend this when transcript discovery is ambiguous or the conversation contains sensitive content.
- `--project-name NAME`: exact slug basis for `~/projects/<name>`. By default, reuse the source repository name.
- `--profile NAME`: target a non-default Matrix CLI profile.
- `--attach`: attach the local terminal after the remote session is created.
- `--approve TOKEN`: upload only when the newly staged scope exactly matches the preview token.

## Safety rules

- Never upload `~/.codex`, `~/.claude`, their SQLite databases, auth files, or all global histories. Only the newest transcript that metadata ties to the active repository may be auto-selected.
- Never upload a transcript discovered only by modification time when its metadata does not match the repository.
- Never add secret files to bypass the built-in exclusion list. Authentication must happen again inside Matrix.
- Never bypass the approval token. If repository files, the continuation brief, transcript content, agent, profile, or destination basis changes, run a new preview and ask for approval again.
- Use the same project name by default; never append `-handoff`. If that destination already exists, do not overwrite it. Ask the user for a different project name and rerun the preview with `--project-name`.
- If automatic transcript discovery finds nothing, continue with the brief only unless the user explicitly supplies a transcript path.
- Do not claim that Matrix resumes the original provider session ID. This is a context handoff into a new remote agent session.
