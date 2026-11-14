# Trusted Matrix Terminal launch adapter

Status: approved to continue isolated implementation/verification. The owner approved the shared bridge in this task; coordinator scope clarification preserves existing Terminal interaction, session survival, restore semantics and platform support. Internal adapter selection has no further blanket approval gate. Significant product/permission changes still require concrete evidence and a separate decision. This document does not claim that an existing Terminal launch is authenticated as a harness.

## Observed gap

The current Zellij daemon launches native children; Node owns an attachment PTY rather than the actual native child. Agent launch environment values become command arguments and persisted startup commands. Agent labels, status bridge metadata, model-emitted OSC and a same-user socket directory do not prove a particular launch or incarnation.

The existing hosted background runner directly spawns the native child under a per-session systemd user service, with control-group termination and ownership prepared before dispatch. It has bounded output files and a service-owned stdin, but no PTY attach/resize interface. The legacy direct PTY path ends with gateway/WebSocket lifetime. Neither is a ready, durable native Terminal launch bridge.

Research evidence: active task research/terminal-cli-trusted-channel-feasibility.md and terminal-hermes-entry.md. Exact local source paths and evidence belong in that research report.

## Alternatives to verify within the approved scope

Compare extending the existing Zellij launch boundary with a trusted source channel against adding hosted PTY attachment to the existing supervisor. Missing APIs establish that adaptation is needed; they do not prove the entire Terminal lifecycle must be replaced. Preserve current sessions, supported platforms and user-visible behavior. Do not install OS helpers, migrate live sessions, use A's GUI/Preview or real accounts, or add system privileges/persistent grants.

Current isolated research: stock Zellij has a plugin pane-PID API, but it requires ReadApplicationState beyond the existing grant set. Targeted stdin writes additionally require WriteToStdin. Neither permission is authorized for silent addition. Stdin-fed plugin pipes avoid argv but may expose their full payload to authorized input-observer plugins, so they are not a proven private credential bootstrap. Darwin process/PTY fixtures demonstrate reconnect/resize and continued native-fixture interaction after a separate attestor is killed/restarted; they do not establish Linux product parity, Zellij integration or real five-harness acceptance.

## Shared bridge candidate

Extend the existing hosted-runner supervision approach into **one shared native Terminal launch bridge**. Reuse the existing five command builders/readiness checks; add the missing real Hermes launcher. It supervises interactive native CLI processes and does not schedule routines or implement model executors.

1. The authenticated Terminal launch service creates owner/Computer/session/incarnation/launch references, checks current launch policy and asks the hosted bridge to spawn the actual selected native process under a PTY. The bridge records the OS child identity and start incarnation from the spawn result.
2. Existing Terminal panes attach, resize and send input through the bridge. Zellij retains its layout/attachment role. Client labels and supplied command/PID metadata never establish source identity.
3. A routine CLI invocation reaches a narrow host broker. The broker verifies OS-backed caller process ownership and ancestry against the bridge's actual native child and current launch incarnation. It accepts only strict routine operations. It never accepts a requested harness, owner, Chat, Bot or run as authority.
4. After fresh lifecycle/action-policy checks, the host issues a per-invocation short-lived capability and launches the fixed packaged CLI with it through the private child handoff. The agent receives the normal structured result. No bearer enters the persisted launch descriptor, startup arguments, shell history, restore state or shared daemon environment.
5. Source revocation and request consumption use the same durable source-generation gate as Chat entries. The canonical Bot backend remains the sole routine scheduler/executor.

The exact OS proof API and PTY attach transport require a bounded spike against supported runtimes before implementation. A self-reported PID or socket name is not an acceptable fallback. Missing OS proof fails closed and remains an unsupported entry, rather than being counted as qualified.

## Lifecycle and visible behavior

| Event | Required behavior |
| --- | --- |
| Gateway or renderer reconnect | Reattach the actual live hosted process; revalidate its generation and current policy before issuing new capabilities. Persisted layout alone grants no authority. |
| Native process exits | Revoke its source generation, retain bounded output/history, show the normal stopped/recoverable state. |
| Source bridge/proof becomes unavailable | Refuse new routine calls and invalidate stale source authority. Keep the still-live Terminal and harness usable; do not force termination or relaunch merely to restore scheduling. |
| Native process is actually gone | Use the existing stopped/recoverable session behavior and deliberate recovery action. Do not silently invent a live identity or reuse a stale PID/generation. |
| Owner terminates/relaunches a tab | Revoke before admitting more CLI requests; the new launch gets a new incarnation. Already accepted canonical work remains a separately tracked request. |
| Manual unattested shell invocation | Return source_context_required; do not infer a harness from command text or focused pane. |
| Routine control succeeds | Report its durable state and separate cancellation uncertainty; source-process termination does not imply canonical routine effects stopped. |

Web Canvas, Web Desktop and Electron Desktop keep the same Terminal actions and source semantics through their shared runtime. Isolated process/PTY tests must prove that the selected adapter preserves current behavior; no session migration or loss of platform support is assumed approved.

## Implementation and evidence boundaries

- Extract focused hosted launch/PTY, broker proof and lifecycle modules; keep composition in the existing Terminal runtime and hosted-runner paths small.
- First test managed-launch ownership, attach/reconnect, resize, termination, stale PID/starttime, reincarnation, foreign process/user/Computer, protocol limits and no serialized secret.
- Prove the OS attestation and PTY boundary with actual isolated processes. Native-harness qualification must invoke the real packaged CLI. Fixture source callbacks are not that evidence.
- Run each of Claude, Codex, Hermes, OpenCode and Pi through this same bridge. Native Pi and managed matrix_pi Chat remain separate routes.
- Preserve the existing owner routine/action approval boundary; bridge creation never grants routine control or background model consent.
- No production rollout, real account, new owner permission, paid resource or GUI occupation is authorized by approving this design. Those remain separately gated.

## Remaining evidence gates

Continue the already approved core, CLI, Chat and five-harness Terminal work. The earlier generic bridge-selection question has been superseded by the owner reply and the narrower scope clarification; do not repeat it. If experiments show that a valid implementation requires new system privileges, session migration, changed close/restore behavior or reduced platform coverage, present the precise impact, alternatives and evidence for a decision before making that change. Do not silently weaken source proof or treat fixture passes as native acceptance.
