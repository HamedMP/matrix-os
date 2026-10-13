// Sketch only. Copy next to a throwaway output dir. Do not commit recordings.
//   node example-recorder.cjs
const path = require("node:path");
const os = require("node:os");
const lib = require("./scripts/record-lib.cjs");

const OUT_DIR = path.join(os.homedir(), "Desktop", "demo videos");
const CLIP = path.join(os.tmpdir(), "mxo-example-chapter.mp4");

async function main() {
  // 1. Launch web or Electron with this repo's Playwright. Confirm 1440x810 @ DPR 2.
  // 2. Inject lib.cursorOverlay. Capture with lib.startCapture / stopCapture.
  // 3. Encode and stitch. Copy the stitched file to OUT_DIR.
  void CLIP;
  void OUT_DIR;
  void lib;
  console.log("This file is a sketch. Write a feature recorder that requires record-lib.cjs.");
}

if (require.main === module) main();
