# Local demo preflight

After the production-parity stack is already running, verify demo readiness with:

```bash
pnpm dev:preflight
```

The command is read-only and bounded. It checks Docker, platform health, VM SSH,
the gateway, shell, and terminal systemd services, verified storage and managed
speech TLS routes, and a real HTML response through the shell proxy. It also
reads the authenticated provider catalog and up to 100 existing Chats, selects
a Chat whose current model is an available canonical Codex route, and reads
`GET /api/chats/:chatId/voice/capabilities?surface=web_desktop`. The capability
read only fetches internal managed-speech metadata; it does not create or alter
a Chat, mint credentials, or make a paid model or speech call.

`PASS aoede` requires an existing Codex Chat's capability status to be
`available`, with `canonical_actions`, `relayed_websocket`, and `hands_free`.
It does **not** prove a real paid voice conversation; that remains an explicit
E2E release check and is always reported separately. An empty Pipedream setup
(`503 integrations_unavailable`) remains an optional `WARN`. Missing Codex auth,
speech readiness, storage/TLS, required services, or authenticated access makes
the command exit nonzero.

If no matching Chat exists, open Aoede once with a Codex Chat and rerun the
preflight; the command deliberately does not bootstrap or mutate one. To check
one known Chat rather than auto-selecting among the bounded list, set
`MATRIX_PREFLIGHT_CHAT_ID=<chat-id>`.

The preflight reads the VM's existing gateway token only inside the VM for
localhost requests. It never prints tokens, environment files, state files, or
service logs.
