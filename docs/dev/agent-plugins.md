# Developer Agent Plugins

Matrix OS contributors share a small set of coding-agent plugins. They are developer tools for working on this repository, not part of the Matrix OS product. The customer-facing plugin lives in `plugins/matrix-os/` and its marketplaces (`.agents/plugins/`, `.claude-plugin/`).

## pstack

[pstack](https://github.com/cursor/plugins/tree/main/pstack) adds rigorous agent workflows (`poteto-mode`, `tdd`, `architect`, `unslop`, `blast-radius`, and others) plus the `poteto-agent` and `comment-sicko` subagents. It tracks `main` of `cursor/plugins`.

### Claude Code

`.claude/settings.json` registers the `cursor-plugins` marketplace and enables `pstack@cursor-plugins`. When you trust the repository folder, Claude Code offers to install it. To install manually:

```text
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
```

Skills appear as `/pstack:<name>`. Run `/pstack:setup-pstack` once to choose models per role.

### Codex

`cursor/plugins` ships no Codex marketplace, so the repository carries a developer marketplace in `.codex/dev-marketplace/` that points at the same upstream directory. Codex records the marketplace by absolute path, so run this from your main checkout, not a temporary worktree:

```sh
codex plugin marketplace add ./.codex/dev-marketplace
codex plugin add pstack@matrix-os-dev
```

Start a new Codex session afterwards. To pick up a newer pstack, run `codex plugin remove pstack@matrix-os-dev` and add it again.
