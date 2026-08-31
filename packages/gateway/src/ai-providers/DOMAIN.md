# AI Provider State Domain

This directory owns the secret-free provider snapshot consumed by Chat and Settings. It keeps execution drivers, owner accounts, funding/access sources, provider instances, readiness, and model policy separate.

- `ProviderCredentialStore` adapts owner-controlled runtime files and the inherited Matrix credential without returning secret material. File presence is `unknown` until a bounded health probe verifies it.
- `AiProviderService` is the sole snapshot composer. Explicit owner selection never silently falls back to Matrix-funded access.
- `ProviderHealthCache` has a fixed cap, TTL/LRU eviction, a recurring sweep, and an explicit shutdown drain owned by the gateway.
- `model-catalog.ts` is a bounded bundled policy. Remote catalogs, executable driver definitions, arbitrary URLs, and owner mutations are not accepted here.
- `GET /api/ai/providers` is read-only and runs behind the gateway's authenticated API boundary. Route failures expose only a generic message.

Provider Settings now derives Hermes, OpenClaw, Claude, Codex, OpenCode, and Pi driver installation state from the existing runtime and executable probes. A driver without a canonical provider/model/access-source instance remains inventory-only; Settings does not invent a routable harness from a binary alone.

The first mutation seam is intentionally narrow:

- Configured, installed Claude and Codex harnesses can start their allowlisted foreground login command in the server-owned canonical shell registry. The returned terminal name is the real attach target, login receipts are bounded and durable, and expired receipts cannot reopen a stale attempt.
- Installed Claude Code 2.1.251 and Codex CLI 0.147.0 were spiked in an isolated temporary home before wiring lifecycle commands: repeated `claude auth logout` and `codex logout` calls both completed without prompts and returned exit code 0. The commands run directly without a shell, with a 10-second timeout, 64 KiB output bounds, and bounded durable receipts. CLI-owned credential files are never deleted by Matrix.
- Logout is exposed only for one exact authenticated account on an installed, server-enabled Claude Code or Codex driver. Removal can clear a disconnected Matrix account profile, but remains absent from the default server because no canonical dependency coordinator is wired; active accounts therefore cannot bypass dependency checks.
- Both CLIs currently expose one active account at a time. Multiple account rows remain valid owner configuration for future support, but lifecycle actions fail closed when more than one row resolves to the same CLI driver rather than pretending Matrix can target concurrent CLI sessions.
- Runtime configuration actions are advertised only from a coordinator's explicit per-action capability list. The default server does not wire one yet because the current provider-settings revision is not the agent-runtime revision and fixed coding-agent routes are chat-scoped.
- Account deletion/reassignment, global route changes, funded-relay activation, metering, and add-on purchases remain fail-closed until their atomic owners exist. Persisting a Settings preference alone is never reported as a successful runtime change.
