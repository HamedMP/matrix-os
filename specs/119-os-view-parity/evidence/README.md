# OS-view parity evidence

Captured on 2026-08-30 and 2026-08-31 from production-built Web and Electron renderers at 1440 × 900. Both captures used a fresh client state and a local stub gateway; the Web capture additionally used the repository's E2E authentication bypass.

## Surface matrix

| Surface | Reciprocal launcher destination | Presentation switch | Core-app fixture |
| --- | --- | --- | --- |
| Web Desktop | Web Canvas | pass | Chat, Settings, Terminal, Files |
| Web Canvas | Web Desktop | pass | Chat, Settings, Terminal, Files |
| Electron Desktop | Canvas / Desktop | pass | Chat, Settings, Terminal, Files |

The screenshots below prove the rendered destinations and real launcher interaction. The shared automated interaction fixture proves that the same four canonical app paths open on the Web and Electron renderers and survive presentation changes; it is intentionally complementary evidence rather than a substitute for these real-renderer captures.

## Web Desktop launcher

The Web Desktop launcher exposes Web Canvas as its first reciprocal OS-view destination, ahead of the shared first-class app sequence.

![Web Desktop launcher with the Web Canvas destination](./web-desktop-launcher.png)

## Web Canvas

Selecting Web Canvas closes the launcher and switches the retained browser OS view to its free-form Canvas presentation.

![Web Canvas presentation](./web-canvas.png)

## Reciprocal Web Desktop destination

Reopening the launcher from Web Canvas exposes Web Desktop in the same launcher position, without replacing the shared app set.

![Web Canvas launcher with the Web Desktop destination](./web-canvas-launcher.png)

The Web capture exercised the real launcher controls in the production-built browser app: `Web Desktop → Web Canvas → reopen launcher`.

## Electron Desktop launcher

The launcher exposes Canvas as its first reciprocal OS-view destination, ahead of the shared first-class app sequence.

![Electron Desktop launcher with the Canvas destination](./electron-desktop-launcher.png)

## Electron Canvas

Selecting Canvas closes the launcher and switches the retained Electron shell to its free-form Canvas presentation.

![Electron Canvas presentation](./electron-canvas.png)

## Reciprocal Desktop destination

Reopening the launcher from Canvas exposes Desktop in the same launcher position, without replacing the shared app set.

![Electron Canvas launcher with the Desktop destination](./electron-canvas-launcher.png)

The Electron capture exercised the real launcher controls in the production-built Electron app: `Desktop → Canvas → reopen launcher`.

## Core interaction smoke

The final parity gate imports one canonical fixture for Chat (`__chat__`), Settings (`__settings__`), Terminal (`__terminal__`), and Files (`__file-browser__`). It checks the Web Desktop app controls, Web Canvas ↔ Web Desktop state retention, Electron Desktop launcher ordering, Electron shared-tab retention, and the shared durable OS-view client/repository contract. Desktop and Canvas geometry are verified as independent presentation namespaces.

These checks run in the dedicated `OS View Parity` CI job whenever shared Web, Electron, brand, UI, contract, or relevant gateway paths change. The path planner and its workflow wiring have their own focused test.
