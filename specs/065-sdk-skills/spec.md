# Feature Specification: SDK-Native Agent Skills

**Feature Branch**: `065-sdk-skills`
**Created**: 2026-04-12
**Status**: Draft
**Input**: User description: "Migrate kernel skills to Claude Agent SDK native skill format while keeping Matrix OS channel routing and legacy skills working. Support the open Agent Skills standard so other agents can consume the same skills."

## Summary

Today Matrix OS ships skills as flat markdown files in `home/agents/skills/*.md` with a custom Zod schema (`triggers`, `category`, `channel_hints`, `composable_with`). The kernel loads them into the system prompt as a TOC and loads bodies on-demand via an IPC tool. The Claude Agent SDK's native `Skill` tool is **not** wired up -- the kernel never passes `settingSources`, so the SDK cannot discover `.claude/skills/` at all.

This spec migrates the kernel to use the SDK-native Skill tool **in addition to** the existing Matrix routing path, adopts the open [Agent Skills](https://agentskills.io) directory format (`<slug>/SKILL.md`), and keeps the 30 existing legacy flat skills readable during transition.

The three recovered 058 skills (`build-matrix-app`, `matrix-app-gallery`, `publish-app`) are written in the new canonical format as part of this spec.

## Goals

1. **SDK-native**: `Skill` tool available in the kernel, discovering skills via `settingSources: ['project']`.
2. **Open standard**: canonical storage at `home/.agents/skills/<slug>/SKILL.md`, consumable by any compliant agent (Claude Agent SDK, VS Code GitHub Copilot, Gemini CLI, OpenCode, Cursor, etc.).
3. **Zero regression**: the 30 legacy flat skills keep working without immediate migration. Existing IPC `load_skill` tool path keeps working. Existing Matrix channel routing keeps working.
4. **Single source of truth**: SDK and Matrix router read the same underlying file. Changes propagate to both paths automatically.
5. **Matrix extensions preserved**: `triggers`, `category`, `channel_hints`, `composable_with`, `examples`, `tools_needed` stay in the YAML frontmatter and continue driving Matrix routing. Standard parsers ignore them.

## Non-goals

- Migrating the 30 existing legacy skills to directory format in this PR. That's a follow-on bulk move.
- Removing the IPC `load_skill` tool. It stays -- Matrix channel routing still needs it.
- Supporting Windows symlinks. Matrix OS ships in Docker (Linux). macOS dev works. Windows is not targeted.
- Building a skill marketplace (handled by 058 app-gallery).

## Architecture

### Canonical storage

```
home/
├── .agents/                  # Open Agent Skills standard
│   └── skills/
│       ├── build-matrix-app/
│       │   └── SKILL.md
│       ├── matrix-app-gallery/
│       │   └── SKILL.md
│       └── publish-app/
│           └── SKILL.md
├── .claude/                  # SDK discovery mirror (runtime-created symlinks)
│   └── skills/
│       ├── build-matrix-app -> ../../.agents/skills/build-matrix-app
│       ├── matrix-app-gallery -> ../../.agents/skills/matrix-app-gallery
│       └── publish-app -> ../../.agents/skills/publish-app
└── agents/                   # Legacy (transitional)
    └── skills/
        ├── weather.md
        ├── translator.md
        └── ... (28 more flat .md files)
```

### Frontmatter schema

Three layers coexist in one YAML block. Parsers ignore unknown keys.

**Open Agent Skills standard** (required by the open spec):
- `name` (required)
- `description` (recommended; used for activation decisions)

**Matrix OS extensions** (optional, used by the kernel's custom router):
- `triggers: string[]` — phrase patterns for channel routing (default `[]`)
- `category: string` — `builder | system | reference | personal | utility` (default `utility`)
- `channel_hints: string[]` — `web | telegram | matrix | any` (default `["any"]`)
- `composable_with: string[]` — other skill slugs (default `[]`)
- `examples: string[]` — user phrase examples (default `[]`)
- `tools_needed: string[]` — informational (default `[]`)

**Claude Code extensions** (optional, SDK reads these when the Skill tool activates):
- `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`, `agent`, `paths`, `hooks`, `shell`

### Loader behavior

`loadSkills(homePath)` scans three locations in this precedence order:

| Order | Location | Format | Purpose |
|---|---|---|---|
| 1 | `home/.agents/skills/<name>/SKILL.md` | directory | Canonical (open standard) |
| 2 | `home/.claude/skills/<name>/SKILL.md` | directory | Third-party / SDK-installed non-symlinks |
| 3 | `home/agents/skills/<name>.md` | flat | Legacy transitional |

When the same `name` appears in multiple locations, the highest-priority one wins and a `[skills] duplicate name` warning is logged. Symlinks in `.claude/skills/` pointing into `.agents/skills/` are detected and skipped (not treated as duplicates) by comparing resolved inode paths.

`SkillDefinition` gains two fields:
- `sourcePath: string` — absolute path to the parsed file
- `format: "flat" | "directory"` — which layout it came from

`loadSkillBody(homePath, name)` consults the same three locations with the same precedence and returns the body of the first match.

### SDK mirror bootstrap

`ensureSdkSkillsMirror(homePath)` runs once at kernel startup, before `query()` is called. For each `home/.agents/skills/<name>/` directory:

1. Ensure `home/.claude/skills/` exists.
2. If `home/.claude/skills/<name>` does not exist → create a relative symlink pointing to `../../.agents/skills/<name>`.
3. If it exists as a symlink pointing to the canonical location → idempotent no-op.
4. If it exists as a symlink pointing elsewhere → update to canonical, log a warning.
5. If it exists as a real file or directory → leave alone (third-party install; don't clobber), log info.
6. On symlink failure (`EACCES`, `EPERM`) → warn and continue. The Matrix router path still works via the kernel's own loader; only the SDK-native path loses visibility on that skill.

### Kernel options wiring

`packages/kernel/src/options.ts` changes:

```ts
import { ensureSdkSkillsMirror } from "./skills.js";

export function kernelOptions(config: KernelConfig) {
  const { db, homePath, sessionId } = config;
  ensureSdkSkillsMirror(homePath);  // NEW: populate .claude/skills mirror
  // ... existing plumbing ...
  return {
    model: config.model ?? "claude-opus-4-6",
    systemPrompt,
    cwd: homePath,                        // NEW: SDK resolves .claude/ relative to user home
    settingSources: ["project"],          // NEW: enable SDK .claude/skills discovery
    permissionMode: "bypassPermissions",
    // ... existing ...
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task", "TaskOutput",
      "WebSearch", "WebFetch",
      "Skill",                            // NEW: SDK native skill invocation
      ...IPC_TOOL_NAMES,
      ...browserToolNames,
    ],
    // ... existing ...
  };
}
```

`SubagentStop`, `PreToolUse`, `PostToolUse` hooks remain unchanged. The existing `mcp__matrix-os-ipc__load_skill` tool stays -- Matrix router still uses it for channel-originated invocations.

## Dual-invocation paths

| Origin | Router | Tool used | Reads from |
|---|---|---|---|
| Telegram/Matrix/WhatsApp channel message | Matrix router → kernel prompt TOC | `mcp__matrix-os-ipc__load_skill` | Loader's canonical resolution (all 3 paths) |
| Web shell `/skill-name` direct invoke | SDK native | `Skill` | `.claude/skills/<name>/SKILL.md` (via mirror symlink) |
| Kernel auto-activation from user message | SDK native | `Skill` | `.claude/skills/<name>/SKILL.md` (via mirror symlink) |
| Subagent preload | Subagent `skills:` field | (preloaded) | SDK scan of `.claude/skills/` |

Both paths read the same underlying `SKILL.md`, so editing a skill once takes effect in both.

## Testing

Unit (`tests/kernel/skills.test.ts`):
- Existing legacy-flat tests stay green.
- New: parse directory `SKILL.md` with minimal standard frontmatter (`name` + `description` only).
- New: parse directory `SKILL.md` with full Matrix + standard + Claude Code frontmatter.
- New: precedence — same name in `.agents/` and legacy flat → `.agents/` wins.
- New: precedence — same name in `.claude/` (non-symlink) and `.agents/` → `.agents/` wins.
- New: symlinked mirror entries dedupe (don't double-count).
- New: `ensureSdkSkillsMirror` creates symlinks idempotently.
- New: `ensureSdkSkillsMirror` does not overwrite existing real files in `.claude/skills/`.
- New: `loadSkillBody` returns body from directory `SKILL.md`.

Integration (`tests/kernel/skills-sdk.test.ts`, new):
- Spawn kernel with haiku model (per CLAUDE.md cost rules).
- Seed one skill at `home/.agents/skills/<name>/SKILL.md`.
- Verify SDK `Skill` tool can discover and activate it.

Regression: `pnpm run test` must pass for `tests/kernel/skills.test.ts`, `tests/kernel/skills-validation.test.ts`, `tests/kernel/skills-store.test.ts`.

## Migration sequence

1. **This PR**: loader dual-read, mirror bootstrap, SDK wiring, spec, 058 recovery, tests.
2. **Follow-on PR** (not in this spec): batch-convert the 30 legacy flat skills to directory format. Mechanical: each `home/agents/skills/<slug>.md` → `home/.agents/skills/<slug>/SKILL.md`, verbatim content, same frontmatter. After verification, delete `home/agents/skills/*.md` and drop the legacy loader branch.
3. **Follow-on PR**: update `home/CLAUDE.md` app-dev docs to point new skills at `home/.agents/skills/` and document the SKILL.md directory format.
4. **Follow-on PR**: update `packages/kernel/src/skill-registry.ts` to write/read from directory format.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Symlink creation fails (EACCES) | `ensureSdkSkillsMirror` catches, logs warn | Skill still works via IPC `load_skill`, only SDK-native `Skill` tool loses visibility for that one |
| Duplicate name across locations | Loader logs `[skills] duplicate name <n>` | Highest-precedence source wins; user sees only the warning |
| Invalid YAML frontmatter | Zod parse fails, loader logs skip warning | Skill silently dropped (current behavior, unchanged) |
| Existing `.claude/skills/<n>` is a real dir from third-party install | Mirror detects non-symlink, logs info, skips | Third-party skill keeps working; no clobber |
| `settingSources` not supported by SDK version | TypeScript type error at build | Caught at compile; not a runtime issue |

## Security

- Skill bodies are read from `homePath` (already inside the container's mounted user home, not user-controlled at runtime).
- No new network calls.
- No new code execution paths beyond what SDK Skill tool already provides.
- `cwd: homePath` scopes SDK discovery to the user's home only, same boundary as today.
- Symlink targets are computed from a fixed relative path (`../../.agents/skills/<name>`), not from any user input. No path traversal risk.

## Resource management

- `ensureSdkSkillsMirror` runs once per kernel spawn (O(n) in skill count, n ≈ 30 today, bounded).
- No long-lived handles. No unbounded growth. No new caches.
- Symlinks are filesystem entries, not memory; they cost ~80 bytes each.

## Open questions

- Should the mirror bootstrap run on file-watcher events for hot-reload of new skills? Not in this spec — the kernel already restarts on config changes. Follow-up if/when live reload matters.
- Should `build-for-matrix.md` (existing) and `build-matrix-app/SKILL.md` (new) be merged? They overlap. Punt: keep both during transition, flag for consolidation in the legacy-skill migration PR.
