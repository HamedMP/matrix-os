import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const mobileRequire = createRequire(new URL("../../apps/mobile/package.json", import.meta.url));
const nativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
const cliRequire = createRequire(nativeRequire.resolve("@react-native/community-cli-plugin/package.json"));
const metroRequire = createRequire(cliRequire.resolve("metro/package.json"));
const converterEntry = require.resolve("@excalidraw/mermaid-to-excalidraw");
const converterRequire = createRequire(converterEntry);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

describe("qualified image and diagram dependency edges", () => {
  test("Wrangler's actual Miniflare Images worker retains native transform behavior", async () => {
    const edgeRequire = createRequire(new URL("../../packages/edge-router/package.json", import.meta.url));
    const wranglerRequire = createRequire(edgeRequire.resolve("wrangler/package.json"));
    const { Miniflare } = wranglerRequire("miniflare");
    const mf = new Miniflare({
      host: "127.0.0.1", port: 0, cf: false, modules: true,
      compatibilityDate: "2026-05-26", images: { binding: "IMAGES" },
      script: `export default { async fetch(req, env) {
        const bytes = await req.arrayBuffer();
        if (new URL(req.url).pathname === "/info") {
          return Response.json(await env.IMAGES.info(new Blob([bytes]).stream()));
        }
        const result = await env.IMAGES.input(new Blob([bytes]).stream())
          .transform({width: 4, height: 3, fit: "fill"}).output({format: "image/png"});
        return result.response();
      } }`,
    });
    try {
      const info = await mf.dispatchFetch("http://image.test/info", {method: "POST", body: png, signal: AbortSignal.timeout(5000)});
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({format: "image/png", width: 1, height: 1});
      const output = await mf.dispatchFetch("http://image.test/transform", {method: "POST", body: png, signal: AbortSignal.timeout(5000)});
      expect(output.status).toBe(200);
      expect(output.headers.get("content-type")).toBe("image/png");
      const bytes = Buffer.from(await output.arrayBuffer());
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([4, 3]);
    } finally {
      await mf.dispose();
    }
  }, 30000);

  test("React Native's actual Metro consumer measures PNG/SVG assets", () => {
    const { getAssetSize } = metroRequire("metro/private/Assets");
    expect(getAssetSize("png", png, "pixel.png")).toEqual({ width: 1, height: 1 });
    expect(getAssetSize("svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="25" height="13"></svg>'), "vector.svg")).toEqual({ width: 25, height: 13 });
    expect(getAssetSize("txt", Buffer.from("text"), "note.txt")).toBeNull();
    expect(() => getAssetSize("png", Buffer.alloc(0), "empty.png")).toThrow(/empty/);
  });

  test("a zero-length ICNS entry cannot exhaust Metro's parser", () => {
    const bytes = Buffer.alloc(16);
    bytes.write("icns"); bytes.writeUInt32BE(16, 4); bytes.write("icp4", 8);
    const entry = metroRequire.resolve("metro/private/Assets");
    const script = `
      const assert = require("node:assert/strict");
      const { getAssetSize } = require(process.argv[1]);
      assert.deepEqual(getAssetSize("png", Buffer.from(process.argv[2], "base64"), "pixel.png"), {width:1,height:1});
      try { getAssetSize("png", Buffer.from(process.argv[3], "hex"), "untrusted.png"); } catch (error) { if (!(error instanceof Error)) throw error; }
      process.stdout.write("parser-finished");
    `;
    const result = spawnSync(process.execPath, ["--max-old-space-size=48", "-e", script, entry, png.toString("base64"), bytes.toString("hex")], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 65536, encoding: "utf8" });
    expect(result.status, `Parser failed to terminate safely: ${result.signal ?? result.error ?? result.stderr}`).toBe(0);
    expect(result.stdout).toBe("parser-finished");
  });

  test("Excalidraw's real class converter keeps valid unique frame IDs and child bindings", async () => {
    const url = pathToFileURL(join(dirname(converterEntry), "converter/types/class.js"));
    const { classToExcalidrawSkeletonConvertor } = await import(url.href);
    const chart = { nodes: [], lines: [], arrows: [], text: [], namespaces: { Accounts: { id: "Accounts", classes: { Customer: {}, Subscription: {} } } } };
    const frames = Array.from({ length: 32 }, () => classToExcalidrawSkeletonConvertor.convert(chart, {}).elements[0]);
    expect(new Set(frames.map((f: { id: string }) => f.id)).size).toBe(32);
    for (const frame of frames) {
      expect(frame).toMatchObject({ type: "frame", name: "Accounts", children: ["Customer", "Subscription"] });
      expect(frame.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    }
  });

  test("the converter's Nanoid dependency terminates on negative non-secure sizes", () => {
    const entry = converterRequire.resolve("nanoid/non-secure");
    const script = `
      const { nanoid } = await import(process.argv[1]);
      const valid = nanoid(21);
      if (typeof valid !== "string" || valid.length !== 21) throw new Error("incompatible Nanoid API");
      try { nanoid(-1); } catch (error) { if (!(error instanceof Error)) throw error; }
      process.stdout.write("generator-finished");
    `;
    const result = spawnSync(process.execPath, ["--max-old-space-size=48", "--input-type=module", "-e", script, pathToFileURL(entry).href], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 65536, encoding: "utf8" });
    expect(result.status, `Generator failed to terminate safely: ${result.signal ?? result.error ?? result.stderr}`).toBe(0);
    expect(result.stdout).toBe("generator-finished");
  });
});
