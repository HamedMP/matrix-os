# Recipe validation evidence

These screenshots use synthetic data only. They show the actual shared Chat UI against a local fixture using canonical HTTP/SSE routes, the Chat repository and the file-backed Agent store. The harness response is scripted; the images do not prove Gmail/Calendar reads or native Hermes execution.

Source: `377be3ba8c88b92df380e224b802945f2b9f4c2c`, September 10, 2026. The long library label was captured after source freeze immediately before this commit; the other images were captured after committing the same source.

- [Mention picker at 390px](recipe-mention-picker-390.png): an 80-character Agent name and a 200-character historical Chat title truncate; full accessible labels remain.
- [Selected mentions at 390px](recipe-mention-tokens-390.png): both labels and the selected-Agent description truncate; both remove controls were exercised successfully.
- [Saved Agent at 390px](recipe-long-label-after.png): the library row and Saved notice remain contained with full accessible names.
- [Pinned recipe receipt](recipe-pinned-receipt-final.png): saved Gmail Work and Calendar Personal selections, skill hashes and expected output are read from the admitted Run. The scripted response arrived without reloading.

The recipe was created through the UI and reopened to verify saved account choices. This shared-component fixture does not establish complete Web Canvas, Web Desktop, Electron Desktop or Web Mobile acceptance. The unchanged Web Chat rail still clipped a synthetic unbroken historical title in this fixture; that observation remains separate from the verified mention labels and the Electron rail correction.

Local checks on the final source passed: 289 distinct covering tests, contracts/gateway/UI/Web/Electron typechecks, and Web/Electron production builds. The Web build used the repository CI public Clerk placeholder and does not establish authentication. Pattern checks reported zero violations. React Doctor reported no shell findings; documented existing Electron composition warnings and a controlled-row positional-key warning remain, with row-removal behavior covered by an interaction test.

Exact Preview deployment, real intended-account reads, source-linked output, cross-presentation persistence and Human Review remain acceptance gates. The feature stays disabled by default; these images are not a production rollout approval.
