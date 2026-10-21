---
name: product-demo-video
description: Matrix team tool for recording captioned click-through demo videos of Matrix OS surfaces (Web Desktop, Web Canvas, Electron Desktop) on an engineer's Mac, with a scripted cursor, time-warped waits, and dissolve chapter cards. Use when asked for a product demo, demo video, or click-through video of a feature in this repo.
---

# Matrix Product Demo Video

## When to Use

This is an internal Matrix engineering tool for this repo. It is not shipped to customer computers and is not part of the `skills/matrix/` pack.

Use this when a Matrix engineer wants a shareable video of a Matrix feature on Web Desktop, Web Canvas, or Electron Desktop. This skill owns capture, captions, pacing, chapter cards, and QA. The click script that tells the feature's story is written fresh for each demo and stays out of git.

Web Mobile can reuse the web recorder with a phone-sized viewport when the user asks. Native Mobile is out of scope. Do not screen-record the agent chatting. Record the product the way a person would use it: open, act, see the result.

## Safety Rules

- Never commit videos, frames, or recorder scripts. Write MP4s to `~/Desktop/demo videos/` and keep frames and timelines in `$TMPDIR`.
- Never spend AI credits, press Send, or press Connect unless the user consents to that exact run.
- Never restart the user's services without consent.
- Record Electron Desktop with an isolated profile. Check sign-in only as a boolean; never print or copy tokens or desktop credentials.
- If a permission such as Full Access was changed in the isolated profile, say so. Do not change the user's everyday app defaults.
- Name surfaces exactly: Web Desktop, Web Canvas, Electron Desktop, Web Mobile, Native Mobile.

Encoding and stitching need macOS (`swiftc` and AVFoundation). There is no ffmpeg in this pipeline.

## Pipeline

1. Run the surface you are recording (see the `launch-app` skill for the local stack).
2. Write a recorder that requires `scripts/record-lib.cjs` and drives Playwright for web surfaces or `_electron.launch` for Electron Desktop.
3. Inject the cursor overlay, glide the mouse to each control, click with a short press, and caption each beat.
4. Capture with `startCapture` / `stopCapture` (CDP screencast at 1440×810 CSS pixels, DPR 2).
5. Encode each chapter with `encodeTimeline`, then join chapters with `stitch`.
6. Copy the result to `~/Desktop/demo videos/<slug>.mp4` and run QA.

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

- For a long wait you already filmed, such as a model run, set `segment.fastForward = 8`.
- For a long streaming answer, set `caption.maxSpeed = 3.5` on that caption.
- Use `snapshotFrame(session)` to grab one frame per poll while a run is in progress.
- Use `wheelScroll(page, deltaY, steps, ms)` to bring finished results into view.
- After a crash, splash screen, or reload at the end, call `trimTail(timeline, seconds)` to cut it and hold the last good frame; captions and camera moves after the cut are dropped.

`encodeTimeline` writes `<output>.manifest.json` next to the MP4. Save `session.timeline` as JSON too. When an edit only changes speed, captions, or a cut, re-encode from the saved timeline. Re-record only when the clicks were wrong, and never re-run AI just to fix the edit.

## QA

```bash
mkdir -p "$TMPDIR/mxo-demo-tools" "$TMPDIR/mxo-demo-qa"
swiftc -O scripts/encode-demo.swift -o "$TMPDIR/mxo-demo-tools/encode-demo"
"$TMPDIR/mxo-demo-tools/encode-demo" sheet "$HOME/Desktop/demo videos/<slug>.mp4" "$TMPDIR/mxo-demo-qa/all" 0.3 <duration> 1 4 24
```

Read every contact sheet. Common bugs: doubled title cards, letterboxing, captions covering the Dock, a leftover Chat window behind a tour, a widget snapping to the wrong corner, a splash or reload at the end, and step counters that do not match the chapter.

A single hero screenshot is not QA. Confirm each chapter tells the story: open, act, result.

## Cleanup

- Sign out of the isolated Electron profile and delete it when the demos are finished.
- Delete `$TMPDIR/mxo-demo-frames-*` once the user has the final video.
- Report the output path, the surfaces actually recorded, and anything you could not capture.

## Additional Resources

- Encoder, stitcher, and recorder API: [scripts.md](scripts.md)
- Recorder starting point: [example-recorder.cjs](example-recorder.cjs)
