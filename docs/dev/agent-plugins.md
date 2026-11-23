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

## matrix-dev

`matrix-dev` packages this repository's own workflow skills: `worktree-pr-monitor`, `monitor-stack-reviews`, `unblock-tickets`, `daily-update`, `release-notes`, and `wrap-up`. It lives in `dev/matrix-dev/` and is listed in the `matrix-os-dev` marketplace in `dev/`, which is separate from the customer marketplace at the repository root.

Inside a Matrix OS checkout you do not need the plugin: the same skills load from `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex), for example `/wrap-up`. Install the plugin to use them from other repositories or to keep one self-updating copy. Plugin skills are namespaced, for example `/matrix-dev:wrap-up`. If the plugin is installed and you work in this checkout, both forms are listed; the unprefixed one is the checkout's own copy.

### Claude Code

`.claude/settings.json` registers the `matrix-os-dev` marketplace with auto-update on, so in a trusted Matrix OS checkout one command installs the plugin for your user:

```sh
claude plugin install matrix-dev@matrix-os-dev --scope user
```

Claude Code's `marketplace add` command cannot point at a marketplace in a subdirectory. To install from outside this repository, add the marketplace to `~/.claude/settings.json` first, then run the install command above:

```json
{
  "extraKnownMarketplaces": {
    "matrix-os-dev": {
      "source": {
        "source": "github",
        "repo": "HamedMP/matrix-os",
        "path": "dev/.claude-plugin/marketplace.json"
      },
      "autoUpdate": true
    }
  }
}
```

The plugin declares no version, so it tracks commits on `main`. With auto-update on, Claude Code refreshes it shortly after a session starts. To update now:

```sh
claude plugin marketplace update matrix-os-dev
claude plugin update matrix-dev@matrix-os-dev
```

### Codex

From your main checkout:

```sh
codex plugin marketplace add ./.codex/dev-marketplace
codex plugin add matrix-dev@matrix-os-dev
```

Codex does not update plugins on its own. To pick up newer skills, run `codex plugin remove matrix-dev@matrix-os-dev` and add it again.

### Changing a skill

Edit the canonical copy in `.agents/skills/<name>/`, run `node scripts/dev/sync-matrix-dev-plugin.mjs`, and commit both. See `dev/matrix-dev/README.md`.
