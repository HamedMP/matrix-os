# Demo video scripts

All paths are relative to this skill directory. Compile Swift tools on first use; `record-lib.cjs` does that.

## encode-demo.swift

```bash
swiftc -O scripts/encode-demo.swift -o /tmp/encode-demo
/tmp/encode-demo encode <manifest.json>
/tmp/encode-demo frames <video.mp4> <out-dir> <seconds...>
/tmp/encode-demo sheet <video.mp4> <out-prefix> <start> <end> <step> [cols] [perSheet]
```

Manifest fields:

| Field | Meaning |
| --- | --- |
| `output` | MP4 path |
| `width`, `height` | 1440×900 |
| `screenHeight` | 810 — captions render in the strip below |
| `fps` | 30 |
| `bitrate` | ~3.2 Mbps |
| `cssWidth` | 1440 |
| `frames[]` | `{ src, crop:[x,y,w,h], caption?, card? }` |

`sheet` needs a hardware decoder. Run it outside the sandbox (`required_permissions: ["all"]`).

## stitch-complete.swift

```bash
swiftc -O -parse-as-library scripts/stitch-complete.swift -o /tmp/stitch-complete
/tmp/stitch-complete recipe.json
```

Recipe:

```json
{
  "output": "/Users/you/Desktop/demo videos/feature.mp4",
  "width": 1440,
  "height": 900,
  "fade": 0.45,
  "bitrate": 3200000,
  "chapters": [
    { "title": "Web Desktop", "subtitle": "Same widget, same place", "cardSeconds": 1.6, "src": "/tmp/web.mp4" },
    { "title": "Done", "subtitle": "PRs #2519–#2536", "cardSeconds": 2.2 }
  ]
}
```

A chapter with no `src` is a card-only outro. The stitcher must trim the previous instruction before appending a fade, or AVFoundation fails with -11841.

## record-lib.cjs

```js
const lib = require("./scripts/record-lib.cjs");
```

Exports: `WEB`, `EL`, `OUT`, `FPS`, `BAND`, `hold`, `now`, `ease`, `cursorOverlay`, `makeSession`, `glide`, `boxOf`, `hover`, `click`, `focusFor`, `camera`, `caption`, `startCapture`, `stopCapture`, `encodeTimeline`, `stitch`, `compileEncoder`, `compileStitcher`.

`encodeTimeline(timeline, css, output, segmentIndex?)` writes `<output>.manifest.json` and the MP4. Optional `segment.fastForward` and `caption.maxSpeed` control squeeze.

`stitch({ output, width, height, fade, chapters })` writes a temp recipe and runs the stitcher.
