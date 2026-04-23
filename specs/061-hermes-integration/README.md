# Spec 061: Hermes Agent Integration

> Install Hermes Agent (Nous Research, MIT) as a second AI kernel in Matrix OS.

## Documents

- **[SPEC.md](./SPEC.md)** -- Main design spec. Architecture, phases, Hermes deep reference.
- **[PATTERNS-TO-COPY.md](./PATTERNS-TO-COPY.md)** -- Specific MIT-licensed patterns worth porting, with source file references.

## Quick Summary

Matrix OS installs Hermes as a Python sidecar process. Users get:

1. **Hermes chat app** in the shell (multi-model, SSE streaming)
2. **`hermes` TUI** in the Matrix OS terminal (full Hermes CLI experience)
3. **External channels** via Hermes's 16+ platform adapters (Telegram, Discord, Matrix, Slack, WhatsApp, etc.)
4. **Matrix protocol bridge** -- `@hermes:matrix-os.com` as a federated bot identity

## Integration Surface

Hermes exposes an OpenAI-compatible HTTP API on port 8642. Matrix OS gateway proxies to it:

```
Browser -> Matrix OS gateway (/api/hermes/*) -> localhost:8642 -> Hermes
```

No Python code runs inside the Node.js process. Two runtimes, one container.

## Why Now

- Multi-model unlock -- 200+ models via OpenRouter alongside Claude
- Hermes is MIT -- copy patterns directly, no legal friction
- Self-improving skills, FTS5 memory, context compression are production-ready
- 16+ channel adapters = massive acceleration on Matrix OS's channel story

## Key Source Files (at `../hermes-agent`)

Read first:
- `gateway/platforms/base.py` -- adapter interface
- `gateway/platforms/api_server.py` -- HTTP API we integrate with
- `gateway/config.py` -- config schema
- `tools/registry.py` -- tool pattern
- `agent/memory_manager.py` -- memory patterns
- `tools/skill_manager_tool.py` -- self-improving skills

Don't read:
- `run_agent.py` (9,700 lines -- skim intro only)
- Test files
- `plugins/`, `nix/`, `rl_cli.py`, `tinker-atropos/`

## Status

Draft -- 2026-04-10
