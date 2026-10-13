// Shared capture / encode / stitch helpers for Matrix product demo videos.
// Feature click-scripts require this file. Do not commit recorded MP4s.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SKILL = path.resolve(__dirname, "..");
const ENCODER_SRC = path.join(__dirname, "encode-demo.swift");
const ENCODER_BIN = path.join(__dirname, "encode-demo");
const STITCH_SRC = path.join(__dirname, "stitch-complete.swift");
const STITCH_BIN = path.join(__dirname, "stitch-complete");

const WEB = { w: 1440, h: 810 };
const EL = { w: 1440, h: 810 };
const OUT = { w: 1440, h: 900, screen: 810 };
const FPS = 30;
const BAND = { x: 0, align: "band" };
const WARP = { step: 1 / 240, active: 1.3, maxActive: 1.9, idle: 9, idleGap: 0.45, slack: 1.2 };

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const hold = (page, ms) => page.waitForTimeout(ms);
const now = () => Date.now() / 1000;
const readSeconds = (text) => 0.9 + text.length * 0.024;

function cursorOverlay(start) {
  if (window.__mxoDemoCursor) return;
  window.__mxoDemoCursor = true;
  const NS = "http://www.w3.org/2000/svg";
  let cursor = null;
  let ring = null;
  let pos = { x: start.x, y: start.y };
  const place = () => {
    if (cursor) cursor.style.transform = `translate(${pos.x - 3.5}px, ${pos.y - 2.3}px)`;
  };
  const install = () => {
    if (cursor && cursor.isConnected) return;
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.head.appendChild(style);
    cursor = document.createElement("div");
    cursor.setAttribute("aria-hidden", "true");
    Object.assign(cursor.style, {
      position: "fixed", left: "0", top: "0", width: "28px", height: "28px", zIndex: "2147483647",
      pointerEvents: "none", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))",
    });
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "28");
    svg.setAttribute("viewBox", "0 0 24 24");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M3 2 L3 19.5 L7.6 15.4 L10.6 22 L13.6 20.7 L10.7 14.2 L17 14.2 Z");
    arrow.setAttribute("fill", "#111");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    cursor.appendChild(svg);
    ring = document.createElement("div");
    ring.setAttribute("aria-hidden", "true");
    Object.assign(ring.style, {
      position: "fixed", left: "0", top: "0", width: "36px", height: "36px", marginLeft: "-18px", marginTop: "-18px",
      borderRadius: "50%", border: "2px solid rgba(17,24,16,0.55)", background: "rgba(155,229,139,0.4)",
      zIndex: "2147483646", pointerEvents: "none", opacity: "0",
    });
    document.body.append(ring, cursor);
    place();
  };
  window.addEventListener("mousemove", (event) => {
    pos = { x: event.clientX, y: event.clientY };
    install();
    place();
  }, true);
  window.addEventListener("mousedown", (event) => {
    install();
    ring.style.left = `${event.clientX}px`;
    ring.style.top = `${event.clientY}px`;
    ring.style.transition = "none";
    ring.style.opacity = "1";
    ring.style.transform = "scale(0.4)";
    void ring.offsetWidth;
    ring.style.transition = "opacity 380ms ease, transform 380ms ease";
    ring.style.opacity = "0";
    ring.style.transform = "scale(1.6)";
  }, true);
}

function makeSession(css) {
  const session = {
    css,
    mouse: { x: 760, y: Math.round(css.h * 0.52) },
    timeline: { frames: [], segments: [], cameras: [], captions: [] },
    writes: [],
    cdp: null,
    step: 0,
    total: 6,
  };
  session.full = { x: 0, y: 0, w: css.w, h: css.h };
  session.focus = { w: Math.round(css.w * 0.8), h: Math.round(css.h * 0.8) };
  return session;
}

async function glide(session, page, x, y, ms = 380) {
  const from = { ...session.mouse };
  const steps = Math.max(8, Math.round(ms / 16));
  const started = Date.now();
  for (let i = 1; i <= steps; i += 1) {
    const k = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    const wait = started + (ms * i) / steps - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
  session.mouse.x = x;
  session.mouse.y = y;
}

async function boxOf(locator) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

async function hover(session, page, locator, ms = 380) {
  const box = await boxOf(locator);
  await glide(session, page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

async function click(session, page, locator, ms = 380) {
  await hover(session, page, locator, ms);
  await hold(page, 90);
  await page.mouse.down();
  await hold(page, 60);
  await page.mouse.up();
}

function focusFor(session, box) {
  const right = box.x + box.width / 2 > session.css.w / 2;
  return {
    x: right ? session.css.w - session.focus.w : 0,
    y: session.css.h - session.focus.h,
    w: session.focus.w,
    h: session.focus.h,
  };
}

async function camera(session, page, rect, seconds = 0.7) {
  session.timeline.cameras.push({ t: now(), rect, dur: seconds });
  if (seconds) await hold(page, seconds * 1000);
}

function caption(session, text, place = BAND, at = now()) {
  session.step += 1;
  session.timeline.captions.push({
    t: at,
    step: `${session.step}/${session.total}`,
    text,
    x: place.x,
    align: place.align,
    top: place.top,
    maxWidth: place.maxWidth,
    keep: false,
  });
}

async function startCapture(session, page) {
  if (!session.cdp) {
    session.cdp = await page.context().newCDPSession(page);
    session.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = path.join(session.timeline.framesDir, `${String(session.timeline.frames.length).padStart(6, "0")}.jpg`);
      session.timeline.frames.push({ t: now(), file, w: metadata.deviceWidth, h: metadata.deviceHeight });
      session.writes.push(fsp.writeFile(file, Buffer.from(data, "base64")));
      session.cdp.send("Page.screencastFrameAck", { sessionId }).catch((error) => console.warn("frame ack failed:", error.message));
    });
  }
  const before = session.timeline.frames.length;
  await session.cdp.send("Page.startScreencast", {
    format: "jpeg", quality: 88, maxWidth: session.css.w * 2, maxHeight: session.css.h * 2, everyNthFrame: 2,
  });
  while (session.timeline.frames.length === before) await hold(page, 20);
  const first = session.timeline.frames[before];
  if (first.w !== session.css.w || first.h !== session.css.h) {
    throw new Error(`screencast frame is ${first.w}x${first.h}, expected ${session.css.w}x${session.css.h}`);
  }
  session.timeline.segments.push({ start: first.t, end: null });
  return first.t;
}

async function stopCapture(session) {
  await session.cdp.send("Page.stopScreencast");
  session.timeline.segments.at(-1).end = now();
}

function compileEncoder() {
  if (!fs.existsSync(ENCODER_BIN) || fs.statSync(ENCODER_BIN).mtimeMs < fs.statSync(ENCODER_SRC).mtimeMs) {
    execFileSync("swiftc", ["-O", ENCODER_SRC, "-o", ENCODER_BIN], { stdio: "inherit" });
  }
}

function compileStitcher() {
  if (!fs.existsSync(STITCH_BIN) || fs.statSync(STITCH_BIN).mtimeMs < fs.statSync(STITCH_SRC).mtimeMs) {
    execFileSync("swiftc", ["-O", "-parse-as-library", STITCH_SRC, "-o", STITCH_BIN], { stdio: "inherit" });
  }
}

function warpSegment(segment, frames, captions, cameras) {
  const arrivals = frames.filter((frame) => frame.t <= segment.end).map((frame) => frame.t);
  const busy = [
    ...cameras.map((event) => [event.t, event.t + event.dur + 0.05]),
    ...captions.map((event) => [event.t, event.t + 0.3]),
  ];
  const steps = [];
  let a = 0;
  for (let t = segment.start; t < segment.end; t += WARP.step) {
    while (a + 1 < arrivals.length && arrivals[a + 1] <= t) a += 1;
    const prev = arrivals[a] ?? segment.start;
    const next = arrivals[a + 1] ?? segment.end;
    const still = next - prev > WARP.idleGap && t > prev + 0.12;
    steps.push({ t, idle: still && !busy.some(([s, e]) => t >= s && t <= e) });
  }
  const bounds = [segment.start, ...captions.map((c) => c.t).filter((t) => t > segment.start && t < segment.end), segment.end];
  const captionFor = (t) => captions.filter((c) => c.t <= t + 1e-6).at(-1);
  const rates = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const inside = steps.filter((step) => step.t >= bounds[i] && step.t < bounds[i + 1]);
    const idleSrc = inside.filter((step) => step.idle).length * WARP.step;
    const activeSrc = inside.length * WARP.step - idleSrc;
    const current = captionFor(bounds[i]);
    const startsHere = current && current.t >= bounds[i] - 0.05;
    const need = startsHere ? readSeconds(current.text) + (i === bounds.length - 2 ? 0.4 : 0) : 0;
    let active = WARP.active;
    let idle = WARP.idle;
    const outFor = () => activeSrc / active + idleSrc / idle;
    if (outFor() < need && idleSrc > 0) idle = Math.max(1, idleSrc / Math.max(1e-6, need - activeSrc / active));
    if (outFor() < need && activeSrc > 0) active = Math.max(1, activeSrc / Math.max(1e-6, need - idleSrc / idle));
    const maxActive = startsHere && current.maxSpeed ? current.maxSpeed : WARP.maxActive;
    if (outFor() > need + WARP.slack && activeSrc > 0) {
      const room = need + WARP.slack - idleSrc / idle;
      active = room > 0 ? Math.min(maxActive, Math.max(active, activeSrc / room)) : maxActive;
    }
    rates.push({ start: bounds[i], end: bounds[i + 1], active, idle });
  }
  const samples = [];
  let outT = 0;
  let nextFrame = 0;
  let r = 0;
  for (const step of steps) {
    while (r + 1 < rates.length && step.t >= rates[r].end) r += 1;
    outT += WARP.step / (step.idle ? rates[r].idle : rates[r].active);
    while (nextFrame / FPS <= outT) { samples.push(step.t); nextFrame += 1; }
  }
  return samples;
}

function encodeTimeline(timeline, css, output, segmentIndex = null) {
  compileEncoder();
  if (Math.abs(css.h / css.w - OUT.screen / OUT.w) > 0.001) throw new Error(`source ${css.w}x${css.h} is not 16:9`);
  const FULL = { x: 0, y: 0, w: css.w, h: css.h };
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
  const at = (event, t) => lerp(event.from, event.rect, event.dur ? ease(Math.min(1, Math.max(0, (t - event.t) / event.dur))) : 1);
  const cameras = timeline.cameras.map((event) => ({ ...event })).sort((a, b) => a.t - b.t);
  cameras.forEach((event, i) => { event.from = i === 0 ? FULL : at(cameras[i - 1], event.t); });
  const rectAt = (t) => {
    let current = null;
    for (const event of cameras) { if (event.t <= t) current = event; else break; }
    return current ? at(current, t) : FULL;
  };
  const segments = segmentIndex == null ? timeline.segments : [timeline.segments[segmentIndex]];
  const inClip = (t) => segments.some((segment) => t >= segment.start - 0.01 && t < segment.end);
  const captions = timeline.captions.filter((event) => inClip(event.t)).map((event) => {
    const segment = segments.find((s) => event.t >= s.start && event.t < s.start + 0.15);
    return { ...event, t: segment ? segment.start : event.t };
  }).sort((a, b) => a.t - b.t);
  captions.forEach((event, i) => { event.clipStep = captions.length > 1 ? `${i + 1}/${captions.length}` : null; });
  const captionAt = (t) => {
    const current = captions.filter((event) => event.t <= t + 1e-6).at(-1);
    if (!current) return null;
    return { step: current.clipStep, text: current.text, alpha: Math.min(1, Math.max(0, (t - current.t) / 0.22)), x: 0, align: "band" };
  };
  const out = [];
  for (const segment of segments) {
    let index = timeline.frames.findIndex((frame) => frame.t >= segment.start);
    if (index < 0) continue;
    const samples = segment.fastForward
      ? Array.from({ length: Math.ceil(((segment.end - segment.start) / segment.fastForward) * FPS) }, (_, i) => segment.start + (i * segment.fastForward) / FPS)
      : warpSegment(segment, timeline.frames, captions, cameras);
    for (const t of samples) {
      while (index + 1 < timeline.frames.length && timeline.frames[index + 1].t <= t) index += 1;
      const rect = rectAt(t);
      out.push({ src: timeline.frames[index].file, crop: [rect.x, rect.y, rect.w, rect.h], caption: captionAt(t), card: null });
    }
  }
  const seconds = out.length / FPS;
  const bitrate = Math.round(Math.min(3_400_000, (8.5 * 8 * 1_000_000) / Math.max(seconds, 8)));
  const manifestPath = output.replace(/\.mp4$/, ".manifest.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    output, width: OUT.w, height: OUT.h, screenHeight: OUT.screen, fps: FPS, bitrate, cssWidth: css.w, frames: out,
  }));
  console.log(`building ${path.basename(output)} ${out.length} frames (${seconds.toFixed(1)}s)`);
  execFileSync(ENCODER_BIN, ["encode", manifestPath], { stdio: "inherit" });
  return output;
}

function stitch(recipe) {
  compileStitcher();
  const recipePath = recipe.recipePath ?? path.join(path.dirname(recipe.output), "recipe.json");
  fs.mkdirSync(path.dirname(recipe.output), { recursive: true });
  fs.writeFileSync(recipePath, JSON.stringify({
    output: recipe.output,
    width: recipe.width ?? OUT.w,
    height: recipe.height ?? OUT.h,
    fade: recipe.fade ?? 0.45,
    bitrate: recipe.bitrate ?? 3_200_000,
    chapters: recipe.chapters,
  }));
  for (const chapter of recipe.chapters) {
    if (chapter.src && !fs.existsSync(chapter.src)) throw new Error(`missing chapter ${chapter.src}`);
  }
  execFileSync(STITCH_BIN, [recipePath], { stdio: "inherit" });
  return recipe.output;
}

module.exports = {
  SKILL, WEB, EL, OUT, FPS, BAND, WARP,
  ease, hold, now, cursorOverlay, makeSession, glide, boxOf, hover, click,
  focusFor, camera, caption, startCapture, stopCapture,
  compileEncoder, compileStitcher, encodeTimeline, stitch,
};
