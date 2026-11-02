import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyStaleBundleError,
  recoverFromStaleBundleError,
  STALE_BUNDLE_RECOVERY_STORAGE_KEY,
} from "@/lib/stale-bundle-recovery";

function memoryStorage(initialValue?: string): Storage {
  const values = new Map<string, string>();
  if (initialValue !== undefined) values.set(STALE_BUNDLE_RECOVERY_STORAGE_KEY, initialValue);
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("stale shell bundle recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes the production webpack ChunkLoadError and fingerprints its runtime", () => {
    const error = Object.assign(
      new Error("Loading chunk 4913 failed. (timeout: https://app.matrix-os.com/__platform-shell/_next/static/chunks/4913-33f6c7c99102b8d7.js)"),
      {
        name: "ChunkLoadError",
        stack: "at __webpack_require__.f.j (https://app.matrix-os.com/__platform-shell/_next/static/chunks/webpack-8e8abca4e92ce4e9.js:1:4021)",
      },
    );

    expect(classifyStaleBundleError(error)).toEqual({
      fingerprint: "webpack-8e8abca4e92ce4e9.js",
      kind: "chunk-load",
    });
  });

  it.each([
    new TypeError("Failed to fetch dynamically imported module: https://app.matrix-os.com/__platform-shell/_next/static/chunks/app/page-a1b2c3.js"),
    new Error("Loading CSS chunk 77 failed. (/__platform-shell/_next/static/css/77-a1b2c3.css)"),
  ])("recognizes browser variants only when they name a Next static asset", (error) => {
    expect(classifyStaleBundleError(error)).toEqual({
      fingerprint: "unknown-next-runtime",
      kind: "chunk-load",
    });
  });

  it.each([
    new TypeError("Failed to fetch"),
    new Error("Loading user document failed"),
    "Loading chunk 4913 failed",
    null,
  ])("does not reload for unrelated errors", (error) => {
    expect(classifyStaleBundleError(error)).toBeNull();
  });

  it("stores the claim before reloading and suppresses the same runtime generation", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const error = Object.assign(new Error("Loading chunk 4913 failed. (/_next/static/chunks/4913.js)"), {
      name: "ChunkLoadError",
      stack: "at /_next/static/chunks/webpack-abc123def456.js:1:1",
    });

    expect(recoverFromStaleBundleError(error, { now: () => 1_000, reload, storage })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.getItem(STALE_BUNDLE_RECOVERY_STORAGE_KEY) ?? "null")).toEqual({
      attemptedAt: 1_000,
      fingerprint: "webpack-abc123def456.js",
      version: 1,
    });

    expect(recoverFromStaleBundleError(error, { now: () => 2_000, reload, storage })).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("allows one recovery for a different runtime generation", () => {
    const storage = memoryStorage(JSON.stringify({
      attemptedAt: 1_000,
      fingerprint: "webpack-old11111111.js",
      version: 1,
    }));
    const reload = vi.fn();
    const error = Object.assign(new Error("Loading chunk 2 failed. (/_next/static/chunks/2.js)"), {
      name: "ChunkLoadError",
      stack: "at /_next/static/chunks/webpack-new22222222.js:1:1",
    });

    expect(recoverFromStaleBundleError(error, { now: () => 2_000, reload, storage })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("fails closed when session storage is unavailable or corrupt", () => {
    const reload = vi.fn();
    const error = Object.assign(new Error("Loading chunk 9 failed. (/_next/static/chunks/9.js)"), {
      name: "ChunkLoadError",
    });
    const throwingStorage = {
      getItem: () => { throw new DOMException("denied"); },
      setItem: vi.fn(),
    } as unknown as Storage;

    expect(recoverFromStaleBundleError(error, { now: () => 1_000, reload, storage: throwingStorage })).toBe(false);
    expect(recoverFromStaleBundleError(error, { now: () => 1_000, reload, storage: memoryStorage("not json") })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not throw when browser policy blocks the sessionStorage getter", () => {
    const reload = vi.fn();
    const error = Object.assign(new Error("Loading chunk 9 failed. (/_next/static/chunks/9.js)"), {
      name: "ChunkLoadError",
    });
    const blockedWindow = Object.defineProperty({}, "sessionStorage", {
      get: () => { throw new DOMException("denied", "SecurityError"); },
    });
    vi.stubGlobal("window", blockedWindow);

    expect(() => recoverFromStaleBundleError(error, { reload })).not.toThrow();
    expect(recoverFromStaleBundleError(error, { reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
