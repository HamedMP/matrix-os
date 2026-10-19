import { createRequire } from "node:module";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "../../desktop");
const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));

it("ships the shared computer selector width in Electron Desktop CSS", async () => {
  const { default: tailwindcss } = await import(desktopRequire.resolve("@tailwindcss/vite"));
  const result = await build({
    configFile: false,
    root: desktopRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      write: false,
      cssMinify: false,
      rollupOptions: { input: path.join(desktopRoot, "src/renderer/src/design/index.css") },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const css = bundles.flatMap((bundle) => "output" in bundle ? bundle.output : [])
    .filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".css"))
    .map((asset) => asset.type === "asset" ? String(asset.source) : "").join("\n");

  // A missing shared-source scan collapsed the absolutely positioned trigger
  // to zero width, putting its monitor icon on top of the account avatar.
  expect(css.includes(".w-\\[156px\\]")).toBe(true);
  expect(css.includes(".max-\\[600px\\]\\:w-28")).toBe(true);
});
