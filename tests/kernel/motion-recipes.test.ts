import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const read = (file: string) => readFileSync(resolve(__dirname, "../../skills/matrix", file), "utf8");
const section = (file: string, title: string) => read(file).split(`## ${title}\n`)[1]?.split("\n## ")[0] ?? "";

describe("copyable motion recipes", () => {
  it("resolves every recipe easing against the documented tokens", () => {
    const definitions = [...read("animate/SKILL.md").matchAll(/(--ease-[\w-]+):\s*(cubic-bezier\([^)]+\))/g)].map((m) => m[1]);
    const references = [...read("animate/RECIPES.md").matchAll(/var\((--ease-[\w-]+)/g)].map((m) => m[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const token of references) expect(definitions, token).toContain(token);
  });

  it("uses the supplied stagger index so successive items have different delays", () => {
    const css = section("animate/css-techniques.md", "Stagger (CSS)");
    const variables = [...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(variables).toContain("--index");
    expect(variables).not.toContain("--stagger");
    expect(css).toMatch(/--delay:\s*120ms/);
  });

  it("normalizes a concrete SVG path and hides its complete stroke", () => {
    const recipe = section("animate/svg-animation.md", "Line-drawing (self-drawing stroke)");
    const length = Number(recipe.match(/<path[^>]*pathLength="([\d.]+)"/)?.[1]);
    const dash = Number(recipe.match(/stroke-dasharray:\s*([\d.]+)/)?.[1]);
    const gap = Number(recipe.match(/stroke-dasharray:\s*[\d.]+\s+([\d.]+)/)?.[1]);
    const offset = Number(recipe.match(/stroke-dashoffset:\s*([\d.]+)/)?.[1]);
    expect(length).toBeGreaterThan(0);
    expect(dash).toEqual(length);
    expect(offset).toEqual(length);
    expect(gap).toBeGreaterThan(dash);
  });

  for (const [title, selector] of [["Orbit (3D)", ".orbitingCircle"], ["Coin flip (3D, two faces)", ".wrapper"]]) {
    it(`disables the decorative ${title} loop under reduced motion`, () => {
      const css = section("css-animations/RECIPES.md", title);
      const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
      expect(reduced).toContain(selector);
      expect(reduced).toMatch(/animation:\s*none/);
      expect(reduced).toMatch(/transform:/);
    });
  }

  it("holds an actual middle frame rather than a whole-cycle offset", () => {
    const css = section("animation-accessibility/SNIPPETS.md", "Looping animation: pause on a hero frame");
    const duration = Number(css.match(/animation:\s*shake\s*([\d.]+)s/)?.[1]);
    const seek = Number(css.match(/animation-delay:\s*-([\d.]+)s/)?.[1]);
    expect(seek % duration).toBeGreaterThan(0);
    expect(seek % duration).toBeLessThan(duration);
  });

  it("keeps the visual-only tab copy out of keyboard and accessibility navigation", () => {
    const recipe = section("animate/RECIPES.md", "Tab indicator with a color transition");
    expect(recipe).toContain("aria-hidden");
    expect(recipe).toContain("inert");
    expect(recipe).toContain("pointer-events: none");
  });
});

function videoFixture(reduced = false, rejectPlay = false, deferPlay = false) {
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = reduced;
  const button = Object.assign(new EventTarget(), { hidden: true, innerText: "Play" });
  const pending: Array<() => void> = [];
  const video = Object.assign(new EventTarget(), { paused: true,
    removeAttribute: vi.fn(),
    setAttribute: vi.fn((name: string) => { if (name === "autoplay") video.paused = false; }),
    play: vi.fn(async () => {
      if (rejectPlay) throw new Error("blocked");
      if (deferPlay) await new Promise<void>((resolve) => pending.push(resolve));
      video.paused = false; video.dispatchEvent(new Event("play"));
    }),
    pause: vi.fn(() => { video.paused = true; video.dispatchEvent(new Event("pause")); }),
  });
  const figure = { querySelector: (selector: string) => selector === "video" ? video : button };
  const remove = vi.spyOn(media, "removeEventListener");
  const context = createContext({ window: { matchMedia: (query: string) => query.includes("no-preference") ? {
    get matches() { return !media.matches; },
    addEventListener: media.addEventListener.bind(media), removeEventListener: media.removeEventListener.bind(media),
  } : media }, document: { querySelector: (selector: string) => selector === "figure" ? figure : selector === "video" ? video : button }, console: { warn: vi.fn() } });
  const code = section("animation-accessibility/SNIPPETS.md", "Autoplaying video").match(/```js\n([\s\S]*?)```/)?.[1];
  if (!code) throw new Error("Video recipe not found");
  runInContext(code, context);
  return { media, video, button, remove, context, finishPlay: async () => {
    pending.shift()?.();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  } };
}

describe("autoplay video recipe behavior", () => {
  it("pauses after a live reduced-motion preference change", async () => {
    const { media, video, button } = videoFixture();
    await Promise.resolve();
    expect(video.paused).toBe(false);
    media.matches = true; media.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(video.paused).toBe(true);
    expect(button.innerText).toBe("Play");
  });

  it("allows deliberate playback while reduced and cleans up listeners", async () => {
    const { video, button, remove, context } = videoFixture(true);
    expect(video.play).not.toHaveBeenCalled();
    button.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(video.paused).toBe(false);
    runInContext("cleanupVideo()", context);
    expect(video.paused).toBe(true);
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("handles blocked playback without a false playing label", async () => {
    const { video, button } = videoFixture(false, true);
    await Promise.resolve();
    expect(video.play).toHaveBeenCalled();
    expect(video.paused).toBe(true);
    expect(button.innerText).toBe("Play");
  });

  it("does not let stale autoplay cancel a newer deliberate play request", async () => {
    const { media, video, button, finishPlay } = videoFixture(false, false, true);
    media.matches = true; media.dispatchEvent(new Event("change"));
    button.dispatchEvent(new Event("click"));
    await finishPlay();
    expect(video.paused).toBe(false);
    await finishPlay();
    expect(video.paused).toBe(false);
  });

  it("stops a pending playback that settles after unmount", async () => {
    const { video, context, finishPlay } = videoFixture(false, false, true);
    runInContext("cleanupVideo()", context);
    await finishPlay();
    expect(video.paused).toBe(true);
  });
});
