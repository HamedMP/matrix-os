# Recipe validation evidence

These screenshots use synthetic data only. They show the actual shared Chat UI against a local fixture using canonical HTTP/SSE routes, the Chat repository and the file-backed Agent store. The harness response is scripted; the images do not prove Gmail/Calendar reads or native Hermes execution.

Source: `377be3ba8c88b92df380e224b802945f2b9f4c2c`, September 10, 2026. The long library label was captured after source freeze immediately before this commit; the other images were captured after committing the same source.

- [Mention picker at 390px](recipe-mention-picker-390.png): an 80-character Agent name and a 200-character historical Chat title truncate; full accessible labels remain.
- [Selected mentions at 390px](recipe-mention-tokens-390.png): both labels and the selected-Agent description truncate; both remove controls were exercised successfully.
- [Saved Agent at 390px](recipe-long-label-after.png): the library row and Saved notice remain contained with full accessible names.
- [Pinned recipe receipt](recipe-pinned-receipt-final.png): saved Gmail Work and Calendar Personal selections, skill hashes and expected output are read from the admitted Run. The scripted response arrived without reloading.

The recipe was created through the UI and reopened to verify saved account choices. This shared-component fixture does not establish complete Web Canvas, Web Desktop, Electron Desktop or Web Mobile acceptance. The historical Web rail clipping seen in the earlier receipt screenshot was corrected at `b675ba8cd`: its local Radix content wrapper now stays within the rail width. [Updated rail and receipt](recipe-rail-and-receipt-fixed.png) shows visible ellipsis. Actual geometry changed from a 410px row inside a 259px viewport to a 243px row inside the same viewport; both 1280px and 390px checks passed, and selecting the row retained the original transcript.

Local checks on the final source passed: 289 distinct covering tests, contracts/gateway/UI/Web/Electron typechecks, and Web/Electron production builds. The Web build used the repository CI public Clerk placeholder and does not establish authentication. Pattern checks reported zero violations. React Doctor reported no shell findings; documented existing Electron composition warnings and a controlled-row positional-key warning remain, with row-removal behavior covered by an interaction test.

Exact Preview deployment, real intended-account reads, source-linked output, cross-presentation persistence and Human Review remain acceptance gates. The feature stays disabled by default; these images are not a production rollout approval.

The Web-only title correction also passed the focused 9-test title suite, the 15-test ChatApp selection/rename suite, shell typecheck and Web production build. Its changed-scope React audit retained the existing ChatApp complexity warning.

## Web theme acceptance correction

Live Web Canvas acceptance exposed a transparent Agents dialog: Web provides `--card` and `--foreground`, while the initial shared styles only recognized Electron and brand variables. The initial fixture imported an additional brand stylesheet that masked this mismatch. After removing that fixture-only stylesheet, the failure reproduced locally.

Correction `4aace8f5f` adds native Web fallbacks within the shared Chat Agents controls. With brand tokens absent, both dialog surfaces now compute an opaque `rgb(252, 252, 248)` background, `rgb(50, 53, 46)` foreground and `rgb(216, 214, 199)` border. The context preview has equal client and scroll widths of 357px in a 390px viewport. These are synthetic actual-browser checks:

- [Agents library on Web themes](recipe-web-theme-after.png)
- [Agents library at 390px](recipe-web-library-theme-390.png)
- [Chat context preview at 390px](recipe-web-context-theme-390.png)

The correction passed 34 focused component tests, UI/Web/Electron typechecks and both production builds. Complete Preview visual acceptance still requires the deployed correction. Before this correction, the saved Daily Brief was created in Web Canvas and read with identical recipe choices in Electron Desktop; real mail and event content was not read.
