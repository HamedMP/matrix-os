// Starting point for a feature recorder. Copy it next to a throwaway output folder, not into git.
//   node example-recorder.cjs
const path = require("node:path");
const os = require("node:os");
const lib = require("./scripts/record-lib.cjs");

const OUT_DIR = path.join(os.homedir(), "Desktop", "demo videos");
const CHAPTER = path.join(os.tmpdir(), "mxo-demo-chapter.mp4");

async function main() {
  // 1. Launch the surface: lib.launchWeb(chromium, session) or lib.launchElectron(electron, { repo, profile }).
  //    Then call lib.assertCssSize(page, lib.WEB) or lib.assertCssSize(page, lib.EL).
  // 2. lib.startCapture(session, page), then caption and click each beat, then lib.stopCapture(session).
  // 3. lib.encodeTimeline(session.timeline, lib.WEB, CHAPTER).
  // 4. lib.stitch({ output: path.join(OUT_DIR, "<slug>.mp4"), chapters: [{ title, subtitle, src: CHAPTER }] }).
  void CHAPTER;
  void OUT_DIR;
  void lib;
  console.log("Write the feature's click script here. See SKILL.md for the full flow.");
}

if (require.main === module) main();
