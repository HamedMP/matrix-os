# matrix-dev

Workflow skills for engineers working on Matrix OS, packaged as a Claude Code
and Codex plugin. It is an internal developer tool, separate from the
customer-facing `plugins/matrix-os` plugin.

| Skill | Use it to |
| --- | --- |
| `worktree-pr-monitor` | Take one change from a worktree to a merge-ready PR |
| `monitor-stack-reviews` | Get a GitHub native PR stack through review and CI |
| `unblock-tickets` | Answer the decisions waiting on you |
| `daily-update` | Write a paste-ready summary of a day's work |
| `release-notes` | Draft Desktop release notes |
| `release-matrix-stable` | Cut a canary host bundle and promote it to stable |
| `release-platform` | Deploy, verify, and roll back the platform service |
| `wrap-up` | Close out a chat whose work has shipped |

Install and update instructions: [`docs/dev/agent-plugins.md`](../../docs/dev/agent-plugins.md#matrix-dev).

## Editing a skill

The files in `skills/` are generated. Edit the canonical copy in
`.agents/skills/<name>/`, then run:

```sh
node scripts/dev/sync-matrix-dev-plugin.mjs
```

Commit both. `tests/platform/matrix-dev-plugin.test.ts` fails when they differ.
To ship another skill, add its name to `MATRIX_DEV_SKILLS` in that script, add
a `.claude/skills/<name>` link to `../../.agents/skills/<name>`, and re-include
the link in `.gitignore`.
