# S0 preview scope profile: partial evidence

**Decision:** S0 remains open. The real bot profile launches on the disposable preview, but the normal owner model route could not be made ready. No model turn, broker inference, steering, cancellation, or 3/3 acceptance run was completed under this profile.

## Exact environment

- Draft PR #2022 preview workflow [run 36485431910](https://github.com/HamedMP/matrix-os/actions/runs/36485431910) completed successfully from head `a16f1e2ff87ce53c2bf3325d52089fdd91abde97`. Its installed host bundle was `v2026.09.28-pr2022-36485431910-1-a16f1e2` on the one disposable `cpx22` preview `pr-2022`.
- `matrix-scope-runtime.service` was active. The supervisor and gateway broker sockets both existed. The supervisor stayed active after the corrected bundle entered service.
- A read-only `capability.get` returned `scope-runtime-bot-v1` with `matrix-bot/0.86.1`, a 1,073,741,824-byte memory ceiling, and a 200% CPU quota.

## Synthetic worker launch

One `competitor-watching` recipe was instantiated once through the authenticated gateway API. This created a synthetic bot, direct Chat, and private workspace on the preview owner. A `runtime.create` request to the real supervisor used the bot's private workspace fingerprint and `broker_only` sandbox network policy. It returned `running`. The transient systemd unit reported `MemoryMax=1073741824`, `CPUQuotaPerSecUSec=2s`, `TasksMax=256`, and `ActiveState=active`. The matching `runtime.stop` returned `stopped`. No worker or systemd unit was left running by this probe.

## Model-route blocker and cleanup

The owner-approved existing Anthropic test key was accepted through `POST /api/settings/api-key`. Its one validation call returned no provider usage, so the spend ledger reserves an additional USD 0.10 pending reconciliation. The key was removed from the preview owner's `system/config.json` after the route probe; `GET /api/settings/api-key/status` then returned `hasKey: false`.

On this new owner, Provider Settings showed Hermes disabled and the current messaging provider/model unset. Setting the Haiku route while Hermes was disabled succeeded, but enabling Hermes through `POST /api/ai/provider-settings/actions` returned `503 provider_settings_unavailable`; the gateway logged `Generic harness configuration failed: ZodError`. A supported Agent settings update to the managed default initialized the previously empty current route, yet enabling Hermes still returned the same 503. A direct Agent settings update to Anthropic Haiku returned `400 agent_config_invalid`. These responses prevent normal Chat admission from proving a funded bot model run. Their root cause remains unconfirmed and is tracked in [issue #2032](https://github.com/HamedMP/matrix-os/issues/2032).

No Gmail or Calendar account was connected, no email was sent, and no live owner data was used. The disposable preview and its synthetic bot remain for a later controlled retry. S0 and Spike A are **not qualified** by this partial profile result.
