# Provider routing contract

## Key workflow

The existing strict body is reused:

```json
{ "version": 2, "harnessId": "claude", "providerId": "openrouter", "apiKey": "<secret>" }
```

`harnessId` may be any compatible entry point exposed by the shared UI; all
OpenRouter variants resolve to the same canonical store. The response contains
only workflow status and a refreshed provider snapshot. Errors are fixed safe
categories and never contain provider payloads.

## Launch contracts

- Pi: portable in-memory credential + exact selected model.
- Kernel/Claude Code: isolated config directory and fixed Anthropic-compatible
  OpenRouter environment.
- Codex: isolated `CODEX_HOME`, non-secret TOML provider definition,
  `OPENROUTER_API_KEY` child environment, Responses wire API.

Child argument vectors contain no secret. Generated files contain no secret.
Ambient `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
`OPENAI_API_BASE`, and ChatGPT auth/profile paths are removed before the
route-specific allowlist is applied.

## Failure contract

Unavailable flag/source/model/generation returns canonical `model_unavailable`
or `authentication_required` as appropriate. Provider, filesystem, and CLI raw
errors are logged only as allowlisted categories. There is no automatic route
or funding fallback.

