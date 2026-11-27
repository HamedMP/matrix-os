# Revert Mac Chat stack #3485

Revert the ten layers of [stack #3485](https://github.com/HamedMP/matrix-os/stack/3485)
for [ENG-602](https://linear.app/matrix-os/issue/ENG-602/revert-mac-chat-stack-3485).
Remove Mac pairing, scoped Mac access, terminal checks and observation from Chat,
Mac activity, and the Mac verification workflow and its packaged support.

Apply the inverse changes from tip to base and land them together. Preserve
subsequent ordinary Chat admission and project setup changes, Herdr Terminal
and private-network pairing, and existing Files behavior. Leave persisted
owner data, Chat history, and database tables in place.

| Surface | Completion check |
| --- | --- |
| Electron Desktop | Mac Chat actions are absent. Ordinary Chat still sends and restores its draft on a rejected send. Terminal still opens. |
| Gateway | Mac desktop-pairing routes are absent. Existing Chat and Herdr Terminal routes remain available. |
| Build and CLI | macOS builds omit the Mac verification support kit. The CLI omits the Mac verification command. |

The removed feature tests described behavior owned by the reverted stack.
Retain the existing Chat, Files, and Terminal regression coverage.

## Public documentation

Handle the public guide separately in `FinnaAI/matrix-os-site`. The [candidate
docs PR #367](https://github.com/FinnaAI/matrix-os-site/pull/367) has not landed,
and the published source under `content/docs/` has no Mac Chat guide or entry
points. Close that candidate PR as part of the rollback. If any of its guidance
lands before the rollback, remove it through a separate site PR.

## Desktop Link enrollment after the rollback

The ENG-495 follow-up keeps one device identity per owner and Matrix computer.
An authenticated owner pairs through Desktop's Device Pairing menu. Gateway
checks the device's signed challenge before recording its key and pairing
revision. Disconnect revokes that revision. An existing device can reuse its
stored key. Pairing alone grants no terminal access.

Chat control of Herdr in [#3772](https://github.com/HamedMP/matrix-os/pull/3772)
uses this identity on Desktop Link. Its integration checks must exercise device
selection, a test in the selected terminal, the exit code in the originating
Chat, and denial after revocation. The dedicated Mac Verification requests,
activity UI, and support kit remain retired.
