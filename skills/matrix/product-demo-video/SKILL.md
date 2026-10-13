---
name: matrix-product-demo-video
description: Record cinematic product demo videos with a scripted mouse, caption strip, time-warp, and dissolve chapter cards. Use when the user asks for a product demo, click-through video, demo recording, team demo, or a video like the onboarding-widget complete cut.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [macos]
triggers: ["product demo", "demo video", "record a demo", "click-through video", "team demo"]
metadata:
  agent:
    tags: [Matrix OS, demo, video, Playwright, Electron, Web Desktop, Web Canvas]
---

# Product demo video

Record demos the way a human would click, then render them as a clean 16:9 film. Do not screen-record the agent chatting. Do not commit MP4s.

## When to use

Use when the user wants a shareable product video of Web Desktop, Web Canvas, Electron Desktop, Web Mobile, or Native Mobile. This skill owns capture, captions, speed, chapter cards, and QA. The feature-specific click script is written per demo.

## Non-negotiables

- **Never put demo videos in the repo.** Write MP4s to `~/Desktop/demo videos/` and keep frames/timelines in the agent store or `$TMPDIR`.
- **Never spend AI credits or press Send / Connect** unless the user explicitly consents to that exact run.
- **Never restart user services** without consent.
- **Never read or copy desktop credentials** or isolated-profile tokens into the reply.
- Name surfaces exactly: Web Desktop, Web Canvas, Electron Desktop, Web Mobile, Native Mobile.
- macOS only for encode/stitch (`swiftc` + AVFoundation). There is no ffmpeg in this pipeline.

## Pipeline

1. Write a feature recorder that drives Playwright (web) and/or `_electron.launch` (Electron).
2. Inject the visible cursor overlay. Glide the mouse. Click with a short press. Caption each beat.
3. Capture with CDP `Page.startScreencast` (jpeg q88, everyNthFrame 2) at **1440×810 CSS, DPR 2**.
4. Encode each chapter with `scripts/encode-demo.swift` through `scripts/record-lib.cjs`.
5. Stitch chapters with `scripts/stitch-complete.swift` (title card → clip, 0.45s dissolve).
6. Copy the result to `~/Desktop/demo videos/<slug>.mp4`.
7. QA with contact sheets. Fix bugs. Re-encode from the saved timeline when possible — do not re-run AI.

## Look

| Rule | Value |
| --- | --- |
| Screen | 1440×810, 16:9, DPR 2 |
| Output frame | 1440×900 (810px screen + 90px caption strip) |
| Mouse | eased glide ~380ms, click hold 90ms / 60ms |
| Camera | optional crop that lerps; start and end on full frame |
| Captions | one line in the strip under the screen, never over UI |
| Steps | recount per chapter (`1/5`), not a leftover global counter |
| Cards | 1.5–2.0s, dark `#0A0E0A`, one card per chapter |
| Crossfade | 0.45s; trim the previous instruction so ranges do not overlap |
| Speed | idle gaps ~9×, motion ~1.3×, keep each caption readable |

## Recorder

Require `scripts/record-lib.cjs` from this skill. Write the click script next to the output dir, not in git.

```js
const lib = require("<skill>/scripts/record-lib.cjs");
const session = lib.makeSession(lib.EL); // or lib.WEB
await page.evaluate(lib.cursorOverlay, session.mouse);
await lib.startCapture(session, page);
lib.caption(session, "The widget opens on first login.", lib.BAND);
await lib.click(session, page, widget.getByRole("button", { name: /Research anything/ }));
await lib.stopCapture(session);
lib.encodeTimeline(session.timeline, lib.EL, outMp4);
lib.stitch({
  output: desktopOut, width: 1440, height: 900, fade: 0.45,
  chapters: [{ title: "Research", subtitle: "Electron Desktop", cardSeconds: 1.6, src: outMp4 }],
});
```

Launch helpers:

- **Web:** Chrome `channel: "chrome"`, `headless: true`, `--window-size=1440,897 --force-device-scale-factor=2`, `viewport: null`. Confirm the first screencast frame is 1440×810.
- **Electron:** `_electron.launch` with `OPERATOR_USER_DATA_DIR` set to an isolated profile. Size the window to 1440×810. Dismiss "Update Matrix OS" with Escape. Confirm `auth:status` only as a boolean, never print tokens.

Motion that does nothing on screen is a bug. Drag past center if "snap back" should return to the starting corner. Minimize leftover Chat windows before an Electron tour.

## Time-warp

`encodeTimeline` compresses stillness and keeps motion readable. For a wait you already filmed (a model run), set `segment.fastForward = 8` instead of leaving it at 1×. For a long streaming caption, set `caption.maxSpeed = 3.5`. After a crash or splash reload, cut the timeline before that frame and hold the last good frame ~2s.

Re-encode from `timeline.json` whenever the edit is only speed, captions, or a cut. Re-record only when the clicks were wrong.

## QA before you call it done

```bash
swiftc -O scripts/encode-demo.swift -o /tmp/encode-demo
/tmp/encode-demo sheet "$HOME/Desktop/demo videos/<slug>.mp4" /tmp/demo-qa/all 0.3 <duration> 1 4 24
```

Read the sheets. Typical bugs: doubled title cards, 16:9 letterboxed into 16:10, captions covering the Dock, leftover Chat behind a tour, snap-to-wrong-corner, splash/reload at the tail, step counters that do not match the chapter.

A single hero screenshot is not QA. Confirm the story: open → act → result.

## Safety on a real computer

- Isolated Electron profile only. Sign out and delete it when the demos are finished.
- Delete `$TMPDIR/mxo-*` frames after the user is done.
- If Full Access or another permission was changed in the isolated profile, say so. Do not change the user's everyday app defaults.
- Follow-up issue for Supervised blocking WebSearch/WebFetch: #2538.

## Additional resources

- Encoder, stitcher, and recorder API: [scripts.md](scripts.md)
- Minimal recorder sketch: [example-recorder.cjs](example-recorder.cjs)
