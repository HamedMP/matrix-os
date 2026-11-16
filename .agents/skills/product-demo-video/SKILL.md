---
name: product-demo-video
description: Matrix team tool for recording captioned demo videos of the real Matrix OS frontend and backend through actual user flows on Web Desktop, Web Canvas, or Electron Desktop. Use when asked for a product demo, demo video, or click-through video of a feature in this repo.
---

# Matrix Product Demo Video

## When to Use

This is an internal Matrix engineering tool for this repo. It is not shipped to customer computers and is not part of the `skills/matrix/` pack.

Use this when a Matrix engineer wants a shareable video of a Matrix feature on Web Desktop, Web Canvas, or Electron Desktop. This skill owns capture, captions, pacing, chapter cards, and QA. The click script that tells the feature's story is written fresh for each demo and stays out of git.

Web Mobile can reuse the web recorder with a phone-sized viewport when the user asks. Native Mobile is out of scope. Record the product the way a person would use it: open, act, see the result. When demonstrating Chat, record the actual Matrix Chat app; the coding agent's work conversation is not product footage.

## Real Product Flow (Required)

Always record the real Matrix frontend connected to its real backend through the actual user flow. A custom HTML/React page, even one importing production components or calling some production code, does not qualify. Do not substitute a custom server or harness, mocked network responses, a synthetic provider, direct SDK/runner execution, replayed events, or injected application state for the product flow. Labeling a substitute does not make it acceptable under this skill.

1. **Verify the runtime before recording.** Identify the requested commit/build and the real frontend URL, backend, and surface. Check the installed or running build rather than trusting a branch name or a successful compile. Start the supported stack and its required services. If the local OS cannot run the real native backend, use a supported isolated preview or test runtime; do not shim away the boundary being verified.
2. **Enter through the product.** Open the feature using its normal navigation and controls. Preserve the real authentication, provider/account selection, permissions, approvals, execution, and persistence paths. Trigger the action from the UI. Supporting CLI/API checks may inspect or configure the isolated environment, but cannot replace the UI action or execute the feature on its behalf.
3. **Verify the actual outcome.** Follow the UI action through the backend using relevant real run IDs, statuses, exit results, logs, or stored data. A rendered success message or an AI claim alone is insufficient. For persistent outcomes, reload or reopen the actual product and verify the same saved result. Claim only the surfaces and behavior actually exercised; a demo is not automatically complete regression coverage.
4. **Keep reviewable evidence.** Save a sidecar evidence file outside git with the exact commit/build, surface, frontend/backend runtime identity, scenario, observed result, and supporting IDs/readbacks. Disclose test configuration and timing overrides, verify them in the effective backend/runner configuration, and restore temporary changes after use. A scaled timing run must be identified as scaled, with the actual elapsed time and configured limits.
5. **Report real blockers.** If runtime access, authentication, provider access, capacity, native services, or the user flow fails, report the observed failure, what remains unverified, and the next step needed. Continue independent preparation where useful, but do not manufacture a successful scene or offer a harness/fake-UI replacement. Do not claim E2E success or a completed feature demo while the required real flow is blocked.

The recorder may drive controls and capture footage. Cursor overlays, captions, crops, and chapter cards may explain that footage; they must never insert product messages, tool output, statuses, or results.

## Safety Rules

- Never commit videos, frames, or recorder scripts. Write MP4s to `~/Desktop/demo videos/` and keep frames and timelines in `$TMPDIR`.
- Never spend AI credits, press Send, or press Connect unless the user consents to that exact run.
- Never restart the user's services without consent.
- Record Electron Desktop with an isolated profile. Check sign-in only as a boolean; never print or copy tokens or desktop credentials.
- If a permission such as Full Access was changed in the isolated profile, say so. Do not change the user's everyday app defaults.
- Name surfaces exactly: Web Desktop, Web Canvas, Electron Desktop, Web Mobile, Native Mobile.

Encoding and stitching need macOS (`swiftc` and AVFoundation). There is no ffmpeg in this pipeline.

## Pipeline

1. Verify the real frontend/backend runtime and intended flow above (see the `launch-app` skill for the local stack).
2. Use the browser/app tools permitted by the user and repository. Where permitted, write a recorder using `scripts/record-lib.cjs` with Playwright for web surfaces or `_electron.launch` for Electron Desktop.
3. Drive the actual product controls, capture the UI action and result, and collect the backend evidence. Add the cosmetic cursor overlay only where permitted.
4. Capture with `startCapture` / `stopCapture` (CDP screencast at 1440×810 CSS pixels, DPR 2) where available. If restricted to the built-in browser, capture that real tab with its supported screenshot API, saving frames and capture timestamps to a timeline; use the encoding helpers without launching a separate browser.
5. Encode each chapter with `encodeTimeline`, then join chapters with `stitch`.
6. Copy the result to `~/Desktop/demo videos/<slug>.mp4` and run QA.

The example below assumes those automation and capture APIs are permitted. It does not authorize a separate browser session, UI injection, or a replacement frontend/backend when the task restricts them.

```js
const lib = require("<skill>/scripts/record-lib.cjs");
const session = lib.makeSession(lib.EL); // or lib.WEB
await page.evaluate(lib.cursorOverlay, session.mouse);
await lib.startCapture(session, page);
lib.caption(session, "Open the feature from the Dock.", lib.BAND);
await lib.click(session, page, page.getByRole("button", { name: /Open/ }));
await lib.stopCapture(session);
lib.encodeTimeline(session.timeline, lib.EL, chapterMp4);
lib.stitch({
  output: finalMp4,
  chapters: [{ title: "Open", subtitle: "Electron Desktop", cardSeconds: 1.6, src: chapterMp4 }],
});
```

`makeSession` creates a fresh `$TMPDIR/mxo-demo-frames-*` folder per session. Compiled Swift tools are cached in `$TMPDIR/mxo-demo-tools/`. Encode and stitch refuse to write inside the skill.

## Look

| Rule | Value |
| --- | --- |
| Screen | 1440×810, 16:9, DPR 2 |
| Output frame | 1440×900: the screen plus a 90px caption strip below it |
| Mouse | eased glide of about 380ms; click hold 90ms down, 60ms up |
| Camera | optional crop that eases in; start and end on the full frame |
| Captions | one line in the strip, never over the UI |
| Steps | numbered per chapter (`1/5`), not with a global counter |
| Cards | 1.5–2.0s on dark `#0A0E0A`, one per chapter |
| Crossfade | 0.45s between cards and clips |
| Pacing | idle gaps about 9×, motion about 1.3×, every caption long enough to read |

Motion that changes nothing on screen is a bug. Do not slow the mouse down, put captions over the Dock, or letterbox 16:9 footage into a 16:10 frame.

## Launching Surfaces

- **Web Desktop / Web Canvas:** `launchWeb(chromium, session)` opens headless Chrome with a 1440×897 window, DPR 2, `viewport: null`, and the cursor overlay preinstalled. Call `assertCssSize(page, lib.WEB)` before recording.
- **Electron Desktop:** `launchElectron(electron, { repo, profile, rendererUrl })` starts the desktop app with `OPERATOR_USER_DATA_DIR` set to the isolated profile, sizes content to 1440×810, keeps the window on top, and disables background throttling. An empty profile is refused so the everyday app data is never used. Call `releaseElectron(app)` before closing it.
- `dismissUpdate(page)` closes the "Update Matrix OS" dialog. Run it after launch and after any reload.
- `hideOpenChat(page)` minimizes a leftover Chat window before a tour.

## Pacing and Edits

`encodeTimeline` compresses stillness and keeps motion readable.

- For a long wait you already filmed, such as a model run, set `segment.fastForward = 8`. Label the sped-up wait and report measured elapsed time separately; edited video duration does not prove runtime duration.
- For a long streaming answer, set `caption.maxSpeed = 3.5` on that caption.
- Use `snapshotFrame(session)` to grab one frame per poll while a run is in progress.
- Use `wheelScroll(page, deltaY, steps, ms)` to bring finished results into view.
- Use `trimTail(timeline, seconds)` to remove unrelated tail footage after the scenario is verified. Never trim a failure into a passing story or remove a reload that is needed to prove persistence. Retain relevant failure evidence and report it as blocked or failed.

`encodeTimeline` writes `<output>.manifest.json` next to the MP4. Save `session.timeline` as JSON too. When an edit only changes speed, captions, or a cut, re-encode from the saved timeline. Re-record only when the clicks were wrong, and never re-run AI just to fix the edit.

## QA

```bash
mkdir -p "$TMPDIR/mxo-demo-tools" "$TMPDIR/mxo-demo-qa"
swiftc -O scripts/encode-demo.swift -o "$TMPDIR/mxo-demo-tools/encode-demo"
"$TMPDIR/mxo-demo-tools/encode-demo" sheet "$HOME/Desktop/demo videos/<slug>.mp4" "$TMPDIR/mxo-demo-qa/all" 0.3 <duration> 1 4 24
```

Read every contact sheet. Common bugs: doubled title cards, letterboxing, captions covering the Dock, a leftover Chat window behind a tour, a widget snapping to the wrong corner, a splash or reload at the end, and step counters that do not match the chapter.

A single hero screenshot is not QA. Confirm each chapter tells the story: open, act, result. Check that the saved timeline references real frame files covering every claimed beat, including the wait and final outcome. Cross-check the video's claims against the backend evidence; captions and edits must not imply a result that was not observed.

## Cleanup

- Sign out of the isolated Electron profile and delete it when the demos are finished.
- Delete `$TMPDIR/mxo-demo-frames-*` once the user has the final video.
- Report the output path, the surfaces actually recorded, and anything you could not capture.

## Additional Resources

- Encoder, stitcher, and recorder API: [scripts.md](scripts.md)
- Recorder starting point: [example-recorder.cjs](example-recorder.cjs)
