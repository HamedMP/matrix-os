# Local demo preflight

After the production-parity stack is already running, verify demo readiness with:

```bash
pnpm dev:preflight
```

The command is read-only and bounded. It checks Docker, platform health, VM SSH,
the gateway, shell, and terminal systemd services, the shell proxy, and the
authenticated gateway provider and capability catalogs. It does not create an
Aoede conversation, mint credentials, or call a model or speech provider.

`PASS aoede` means the local product prerequisites and an available
reasoning/tools route are verified. It does **not** prove a real paid voice
conversation; that remains an explicit E2E release check and is always reported
separately. An empty Pipedream setup (`503 integrations_unavailable`) is an
optional `WARN`, while a missing required service, capability route, provider
route, or authenticated access makes the command exit nonzero.

The preflight reads the VM's existing gateway token only inside the VM for
localhost requests. It never prints tokens, environment files, state files, or
service logs.
