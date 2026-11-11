# Project instruction discovery in Chat

Project attachment and model selection are separate. Canonical Chat resolves the authenticated owner's active project and optional worktree by stored identity at admission. It revalidates the selected root before dispatch and binds continuation to root provenance. Coding adapters then start or resume the selected harness in the eligible workspace. Model funding and the inference relay do not load repository instructions.

| Route | Instruction discovery and timing | Evidence |
| --- | --- | --- |
| Matrix AI managed Pi | Neither file is attached automatically. The supervised or full-access run receives a project or worktree mount and scoped tools. The worker builds a `pi-agent-core` agent from the admitted prompt and system prompt. A file may enter context if the agent explicitly reads it through an allowed tool. | Actual worker and model context using a synthetic supervisor and inference transport. Project mount and broker capabilities verified. |
| Native Codex Chat | Codex App Server loads `AGENTS.override.md` or `AGENTS.md` from its detected project root to the resolved cwd. The default repository budget is 32 KiB. `CLAUDE.md` requires an explicitly configured fallback. The harness can reuse repository instructions while its environment selection and trust stay the same. Reopening the agent session can refresh its view. | Pinned 0.162.1, through Matrix launcher and App Server bridge to loopback Responses. Verified primary, linked worktree, root markers, and restart/resume. No live provider account used. |
| Native Claude Code Chat | The launch uses the admitted cwd, empty setting sources and strict MCP configuration. It does not automatically load either project file. This launch policy applies to the owner profile and owner API key route. | Pinned 2.1.280 through the actual adapter and synthetic loopback Messages. Explicit project-source control included `CLAUDE.md`; both default-launch markers were absent. |
| Native Pi Chat | Matrix passes `--no-context-files`, `--no-skills`, `--no-extensions` and `--no-prompt-templates`. Project context is deliberately suppressed. Native Terminal sessions are separate and depend on CLI flags and trust. | Gateway launch contract and tests. |
| Native OpenCode Chat | Matrix sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` and passes read-only policy. Matrix supplies no project Markdown. Native global or on-demand behavior is version dependent. | Gateway launch contract. Installed CLI behavior was not qualified. |
| Claude kernel and isolated shared runtime | Legacy owner kernel forwards cwd and allows project settings, so its SDK can load `CLAUDE.md` and supported imports. The bundled 2.1.240 CLI predates the native `AGENTS.md` fallback. The retired funded kernel binding cannot start. The isolated shared Claude runtime uses a separate `/workspace`, no tools and empty setting sources. The isolated Codex worker is a distinct read-only exec path. | Source, plus the bundled CLI discovery control and the separate Codex isolation contract. |
| Hermes and OpenClaw | Ordinary Hermes gets the admitted cwd; restricted recipe Hermes gets its independent profile root. Matrix does not inject instruction files. Installed Hermes discovery was not measured. OpenClaw receives a session key and prompt over RPC with no project cwd. | Adapter source. |
| App AI and raw inference | These APIs have their own workspace and credential behavior. They do not receive canonical project Chat execution-root context. | API and worker wiring. |

A folder project's Matrix root can differ from the Git root recognized by Codex, for example if the folder is nested under a larger repository. The tested Git checkout and worktree were independently fenced by their repository markers. Codex can consult an ancestor inside its own detected Git scope in other layouts. Changing that behavior would require an explicit project-boundary policy decision.

## Agent configuration

**Agent configuration** in the personal project overview has Skills, MCP and Config files sections. Its metadata covers the primary checkout. A Chat can run in a different worktree, and runtime policy determines what it loads. The panel includes existing root instructions, skill manifests, MCP server names and the recognized configuration files, including an empty or invalid MCP configuration that the owner may need to edit.

The owner can open a specific file in the existing editor or preview and explicitly create a starter skill, instruction file or empty MCP declaration. The inventory and exact file location use descriptor-relative Linux inspection. They fail closed without those capabilities. The existing Files create route validates the immutable project identity and matches the known project-relative path to the current root under the existing write admission. It publishes the new file under a held checkout directory and preserves existing files. Contents requested through an editor retain existing Files permissions. Computer-level MCP connection credentials, tool approvals and connection state remain in Settings.

After editing a declaration, return to Agent configuration and select **Refresh** to see its
updated server list. File reads through the existing editor are private and uncached. Saving an
existing file retains its filesystem access mode. On Web, a failed read blocks editing until the
file can be reopened, and a failed write keeps the draft available for retry.

See [the project context spec](../../specs/2691-project-agent-context/spec.md) and the [Codex 0.162.1 instruction loader](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/agents_md.rs).
