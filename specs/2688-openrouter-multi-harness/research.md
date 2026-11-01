# Research and sanitized spikes

## Scope and safety

No billable inference was performed. No OpenRouter key, prompt, response, or
private content was captured. These local non-mutating checks validate CLI
parsing and documented launch surfaces; the capability flag remains off until
the paid live suite is explicitly approved.

## Pinned/runtime versions

- Production scope pin: Claude Code `2.1.240`.
- Local Claude Code inspected: `2.1.278`.
- Production scope pin: Codex `0.162.1`.
- Local Codex inspected: `0.162.0`.
- Checked-in Codex exec/app-server contracts: through `0.164.0`.

## Claude Code and Agent SDK

Source: [OpenRouter Claude Code integration](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration).

Documented child environment:

```text
OPENROUTER_API_KEY=<child-only secret>
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<same child-only secret>
ANTHROPIC_API_KEY=
```

The guide states that Claude Code uses the Anthropic-compatible endpoint and
warns that an existing native login can conflict. Therefore Matrix uses an
isolated profile/config directory rather than logging out or reusing the
owner's normal profile. Local help inspection confirmed machine-readable
streaming, tool, cancellation, and resume surfaces. Agent SDK V1 inherits the
same endpoint/token environment, but tools and `query()` resume still require a
billable exact-version qualification.

## Codex

Sources: [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
and [OpenRouter Codex guide](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/).

The local pinned-compatible CLI accepted this non-secret custom-provider shape
during `codex exec --help` parsing:

```toml
model_provider = "openrouter"
model = "openai/gpt-5.6-luna"

[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

No request was sent. Matrix will generate this in an isolated profile, set the
key only in the child environment, and supply exact Matrix-managed model
metadata. The built-in `openai` provider is not modified.

## Required live qualification

With explicit approval and a disposable test key, run the exact pinned release
binaries for all four paths and record only command shape, versions, exit/result
class, model attribution, and provider activity. Qualify streaming, one bounded
tool, cancellation, restart/resume, rotation, revocation, and model removal.
Any unsupported behavior removes that model/harness pair from the checked-in
matrix before the operational flag can be enabled.

