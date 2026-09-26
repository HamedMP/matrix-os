import { describe, expect, it, vi } from "vitest";
import { readFileSync, readFile } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

vi.mock("next/font/local", () => ({ default: (options: Record<string, unknown>) => ({ ...options, variable: options.variable }) }));
const expected = [
  ["inter", "Inter", "--font-inter", ["100 900"], ["normal"]],
  ["instrumentSans", "Instrument Sans", "--font-instrument", ["400 700"], ["normal"]],
  ["instrumentSerif", "Instrument Serif", "--font-serif-display", ["400", "400"], ["normal", "italic"]],
  ["jetbrainsMono", "JetBrains Mono", "--font-jetbrains", ["100 800"], ["normal"]],
  ["cormorant", "Cormorant Garamond", "--font-serif", ["300", "400", "500"], ["normal", "normal", "normal"]],
  ["orbitron", "Orbitron", "--font-orbitron", ["400", "500", "600", "700"], ["normal", "normal", "normal", "normal"]],
  ["geistSans", "Geist", "--font-geist-sans", ["100 900"], ["normal"]],
  ["geistMono", "Geist Mono", "--font-geist-mono", ["100 900"], ["normal"]],
  ["bricolage", "Bricolage Grotesque", "--font-bricolage", ["200 800"], ["normal"]],
] as const;
const require = createRequire(resolve("shell/package.json"));
const loader = require("next/dist/compiled/@next/font/dist/local/loader.js").default;

describe("production shell fonts are deterministic local assets", () => {
  it.each(expected)("emits %s with existing weight/style tokens and real WOFF2 bytes", async (name, family, variable, weights, styles) => {
    const fonts = await import("../../shell/src/app/fonts.js");
    const options = (fonts as unknown as Record<string, { variable: string; preload: boolean; display: string; src: { path: string; weight: string; style: string }[] }>)[name];
    expect(options.variable).toBe(variable); expect(options.preload).toBe(false);
    expect(options.display).toBe(name === "bricolage" ? "block" : "swap");
    expect(options.src.map(asset => asset.weight)).toEqual(weights);
    expect(options.src.map(asset => asset.style)).toEqual(styles);
    const emitted: Buffer[] = [];
    const result = await loader({ functionName: "", variableName: name, data: [options],
      resolve: async (path: string) => resolve("shell/src/app", path), loaderContext: { fs: { readFile } },
      emitFontFile: (bytes: Buffer) => { emitted.push(bytes); return "/synthetic/local.woff2"; },
    });
    expect(emitted.length).toBe(weights.length);
    for (const bytes of emitted) expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(result.css).not.toMatch(/https?:/);
    const packagePath = options.src[0].path.split("/files/")[0];
    const metadata = JSON.parse(readFileSync(resolve("shell/src/app", packagePath, "metadata.json"), "utf8"));
    expect(metadata.family).toBe(family);
  });
  it("uses the local font module on the actual document path", () => {
    const layout = readFileSync("shell/src/app/layout.tsx", "utf8");
    expect(layout).toContain('from "./fonts"');
    expect(layout).not.toContain("next/font/google");
  });
});
