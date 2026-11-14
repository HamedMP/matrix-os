import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_BUNDLE_LIMITS,
  AppBundleError,
  bundleDigest,
  decodeAppBundle,
  encodeAppBundle,
  validateBundlePath,
} from "../../packages/contracts/src/app-store-bundle";

const sourceFiles = () => new Map<string, Buffer>([
  ["matrix.json", Buffer.from('{"name":"x"}')],
  ["package.json", Buffer.from("{}")],
  ["pnpm-lock.yaml", Buffer.from("lockfileVersion: 9")],
  ["index.html", Buffer.from("<div id=root></div>")],
  ["src/App.tsx", Buffer.from("export const App = () => null;")],
]);

function rawBundle(document: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(document)));
}

function entry(path: string, data: Buffer) {
  return { path, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof AppBundleError ? error.code : "other"; }
  return undefined;
}

describe("encodeAppBundle / decodeAppBundle", () => {
  it("round-trips files and sorts them", () => {
    const encoded = encodeAppBundle("source", sourceFiles());
    const decoded = decodeAppBundle(encoded, { kind: "source" });
    expect([...decoded.files.keys()]).toEqual(["index.html", "matrix.json", "package.json", "pnpm-lock.yaml", "src/App.tsx"]);
    expect(decoded.files.get("src/App.tsx")?.toString()).toBe("export const App = () => null;");
    expect(decoded.entries[0]).toMatchObject({ path: "index.html", size: 19 });
  });

  it("is deterministic regardless of insertion order", () => {
    const reversed = new Map([...sourceFiles()].reverse());
    const a = encodeAppBundle("source", sourceFiles());
    const b = encodeAppBundle("source", reversed);
    expect(a.equals(b)).toBe(true);
    expect(bundleDigest(a)).toBe(bundleDigest(b));
    expect(bundleDigest(a)).toBe(createHash("sha256").update(a).digest("hex"));
  });

  it("requires source files and the dist index", () => {
    const files = sourceFiles();
    files.delete("pnpm-lock.yaml");
    expect(codeOf(() => encodeAppBundle("source", files))).toBe("missing_required_file");
    expect(codeOf(() => encodeAppBundle("dist", new Map([["assets/a.js", Buffer.from("")]])))).toBe("missing_required_file");
    expect(decodeAppBundle(encodeAppBundle("dist", new Map([["index.html", Buffer.from("x")]])), { kind: "dist" }).files.size).toBe(1);
  });

  it("rejects the wrong kind", () => {
    const dist = encodeAppBundle("dist", new Map([["index.html", Buffer.from("x")]]));
    expect(codeOf(() => decodeAppBundle(dist, { kind: "source" }))).toBe("invalid_format");
  });

  it.each([
    "../escape.ts", "/abs.ts", "src//double.ts", "src/./dot.ts", "src\\win.ts", "src/\u0001.ts",
    `${"a/".repeat(12)}deep.ts`, `src/${"x".repeat(129)}.ts`, "",
  ])("rejects unsafe path %j", (path) => {
    expect(codeOf(() => validateBundlePath(path, "dist"))).toBe("invalid_path");
  });

  it.each([
    "node_modules/x/index.js", ".git/config", "dist/index.html", ".env", ".env.local", "app/.env.production",
    ".build-stamp", ".build.log", "logs/server.log", ".matrix-store/report.json",
  ])("excludes %s from source bundles", (path) => {
    expect(codeOf(() => validateBundlePath(path, "source"))).toBe("excluded_path");
  });

  it("allows dist paths that are excluded only for source", () => {
    expect(() => validateBundlePath("assets/index-abc.js", "dist")).not.toThrow();
  });

  it("rejects duplicate, unsorted, mismatched and oversized entries", () => {
    const html = Buffer.from("x");
    const base = { format: "matrix-app-bundle/1", kind: "dist" };
    expect(codeOf(() => decodeAppBundle(rawBundle({ ...base, files: [entry("index.html", html), entry("index.html", html)] }), { kind: "dist" })))
      .toBe("invalid_format");
    expect(codeOf(() => decodeAppBundle(rawBundle({ ...base, files: [entry("z.js", html), entry("index.html", html)] }), { kind: "dist" })))
      .toBe("invalid_format");
    expect(codeOf(() => decodeAppBundle(rawBundle({ ...base, files: [{ ...entry("index.html", html), sha256: "0".repeat(64) }] }), { kind: "dist" })))
      .toBe("hash_mismatch");
    expect(codeOf(() => decodeAppBundle(rawBundle({ ...base, files: [{ ...entry("index.html", html), size: 2 }] }), { kind: "dist" })))
      .toBe("hash_mismatch");
    expect(codeOf(() => decodeAppBundle(Buffer.from("not gzip"), { kind: "dist" }))).toBe("invalid_format");
    expect(codeOf(() => decodeAppBundle(rawBundle({ ...base, files: [entry("index.html", html)], extra: 1 }), { kind: "dist" })))
      .toBe("invalid_format");
  });

  it("enforces file and total limits", () => {
    const big = Buffer.alloc(APP_BUNDLE_LIMITS.maxFileBytes + 1);
    expect(codeOf(() => encodeAppBundle("dist", new Map([["index.html", Buffer.from("x")], ["big.bin", big]])))).toBe("limit_exceeded");
    const many = new Map<string, Buffer>([["index.html", Buffer.from("x")]]);
    for (let i = 0; i < APP_BUNDLE_LIMITS.maxFiles; i++) many.set(`f/${i}.js`, Buffer.from(""));
    expect(codeOf(() => encodeAppBundle("dist", many))).toBe("limit_exceeded");
  });

  it("stops inflating bombs at the decompressed limit", () => {
    const bomb = gzipSync(Buffer.alloc(APP_BUNDLE_LIMITS.maxInflatedBytes + 1024, 0x20));
    expect(bomb.length).toBeLessThan(APP_BUNDLE_LIMITS.maxCompressedBytes);
    expect(codeOf(() => decodeAppBundle(bomb, { kind: "dist" }))).toBe("limit_exceeded");
  });

  it("rejects compressed input above the compressed limit", () => {
    expect(codeOf(() => decodeAppBundle(Buffer.alloc(APP_BUNDLE_LIMITS.maxCompressedBytes + 1), { kind: "dist" }))).toBe("limit_exceeded");
  });

  it("produces gzip with a zeroed mtime", () => {
    const encoded = encodeAppBundle("dist", new Map([["index.html", Buffer.from("x")]]));
    expect(encoded.readUInt32LE(4)).toBe(0);
    expect(JSON.parse(gunzipSync(encoded).toString()).format).toBe("matrix-app-bundle/1");
  });
});
