# Web ChatGPT subscription access (ENG-292)

[Ticket](https://linear.app/matrix-os/issue/ENG-292/support-codex-chatgpt-subscriptions-on-web-desktop-and-web-canvas) · [PR #2608](https://github.com/HamedMP/matrix-os/pull/2608)

## Supported journey

Before the Codex Settings handoff, explicitly disclose that ChatGPT subscription
management requires Electron Desktop on the owner's device and the paired device
must stay connected while chats and Matrix Bots run. Browser subscription
management is unsupported; native Codex login and API keys remain separate.

In shared Settings, a validated Provider V3 projection with a fresh ready peer,
account and models can show runtime availability without a local management
client. No browser connect/disconnect/replacement action is introduced. Missing,
expired or non-ready peer observations must not claim runtime availability.
Native local management receipts and actions remain unchanged.

## Boundaries

No endpoint, IPC, credential storage, enrollment, funding or device-binding
changes. Browser cookies still cannot enroll native peers. Owner/Computer
bearer verification, signed device proofs and persisted-key CAS stay intact.
The native Codex stack #2547 → #2548 → #2549 → #2545 is excluded.

## Acceptance and validation

- Exact pre-entry owner-device management and paired-device online statements.
- Healthy V3 peer remains ready without browser management transport; absent or
  expired peer stays unavailable; refresh and identity changes use current props.
- Native connection/replacement and browser-cookie denial regressions pass.
- Validate Web Canvas, Web Desktop and Electron Desktop separately; shared
  Web Mobile copy is also affected. Native Mobile has no shared provider Settings
  surface here; document applicability and obtain reviewer approval for N/A.
- Run affected tests/types/lint, React Doctor, pattern checks and shell build.
- Require current-build screenshots and recordings; fixtures are not live proof.
- Companion `FinnaAI/matrix-os-site` docs PR under `content/docs/` must describe
  management versus runtime access and device requirements before release.

Product/design and provider-integration owner review is recommended. Implementation
is authorized by the requester; live surface evidence remains unqualified until
captured. No browser OAuth support is promised.
