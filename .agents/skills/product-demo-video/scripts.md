# Demo Video Scripts

Paths are relative to this skill directory. `record-lib.cjs` compiles both Swift tools into `$TMPDIR/mxo-demo-tools/` on first use, naming each build by a hash of its source and flags so worktrees never share a stale binary. Each use keeps the four most recently used builds per tool, deletes the rest, and removes partial compiles older than 10 minutes.

## encode-demo.swift

```bash
mkdir -p "$TMPDIR/mxo-demo-tools" "$TMPDIR/mxo-demo-qa"
swiftc -O scripts/encode-demo.swift -o "$TMPDIR/mxo-demo-tools/encode-demo"
"$TMPDIR/mxo-demo-tools/encode-demo" encode <manifest.json>
"$TMPDIR/mxo-demo-tools/encode-demo" frames <video.mp4> <out-dir> <seconds...>
"$TMPDIR/mxo-demo-tools/encode-demo" sheet <video.mp4> <out-prefix> <start> <end> <step> [cols] [perSheet]
```

Manifest fields:

| Field | Meaning |
| --- | --- |
| `output` | MP4 path |
| `width`, `height` | 1440×900 |
| `screenHeight` | 810; captions render in the strip below |
| `fps` | 30 |
| `bitrate` | about 3.2 Mbps |
| `cssWidth` | 1440 |
| `frames[]` | `{ src, crop: [x, y, w, h], caption?, card? }` |

`frames` and `sheet` decode video with AVFoundation. Agent sandboxes that block hardware decoders must run them outside the sandbox.

## stitch-complete.swift

```bash
swiftc -O -parse-as-library scripts/stitch-complete.swift -o "$TMPDIR/mxo-demo-tools/stitch-complete"
"$TMPDIR/mxo-demo-tools/stitch-complete" recipe.json
```

Recipe:

```json
{
  "output": "/absolute/path/to/demo videos/feature.mp4",
  "width": 1440,
  "height": 900,
  "fade": 0.45,
  "chapters": [
    { "title": "Web Desktop", "subtitle": "Open the feature", "cardSeconds": 1.6, "src": "/tmp/web.mp4" },
    { "title": "Done", "subtitle": "What shipped", "cardSeconds": 2.2 }
  ]
}
```

The export uses AVFoundation's highest-quality preset, which chooses the final bitrate. The stitcher does not expand `~` or `$HOME`, so pass absolute paths. A chapter with no `src` is a card-only outro. When a crossfade starts, the stitcher trims the previous instruction so time ranges never overlap; overlapping ranges make AVFoundation fail with error -11841.

## record-lib.cjs

```js
const lib = require("./scripts/record-lib.cjs");
```

Exports: `SKILL`, `TOOLS_DIR`, `ENCODER_BIN`, `STITCH_BIN`, `WEB`, `EL`, `OUT`, `FPS`, `BAND`, `WARP`, `ease`, `hold`, `now`, `fadeOverlapSeconds`, `cursorOverlay`, `makeSession`, `glide`, `boxOf`, `hover`, `click`, `focusFor`, `camera`, `caption`, `startCapture`, `stopCapture`, `dragHandle`, `dismissUpdate`, `assertCssSize`, `launchWeb`, `launchElectron`, `releaseElectron`, `hideOpenChat`, `snapshotFrame`, `wheelScroll`, `trimTail`, `cameraPath`, `toolPath`, `pruneTools`, `compileEncoder`, `compileStitcher`, `encodeTimeline`, `stitchRecipe`, `stitch`.

- `makeSession(css)` returns a session whose `timeline.framesDir` is a new `$TMPDIR/mxo-demo-frames-*` folder.
- `encodeTimeline(timeline, css, output, segmentIndex?)` writes `<output>.manifest.json` and the MP4. Optional `segment.fastForward` and `caption.maxSpeed` control pacing.
- `stitch({ output, width, height, fade, chapters })` writes `recipe.json` next to the output and runs the stitcher.
- `dragHandle(session, page, handle, toX, toY)` grabs a handle and drags it over 620ms. Drop a corner-snapping widget past the middle of the screen so it snaps to the intended corner.
