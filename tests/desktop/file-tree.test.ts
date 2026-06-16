import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useFileTree } from "@desktop/renderer/src/stores/file-tree";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeApi(get: ApiClient["get"]): ApiClient {
  return {
    baseUrl: "https://x.test",
    get,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  } as ApiClient;
}

beforeEach(() => {
  useFileTree.setState({
    roots: null,
    childrenByPath: {},
    expanded: {},
    loadingRoots: false,
    loadingPaths: {},
  });
});

describe("useFileTree", () => {
  it("coalesces concurrent root loads", async () => {
    const rootLoad = deferred<{ entries: unknown[] }>();
    const get = vi.fn(() => rootLoad.promise);
    const api = makeApi(get as never);

    const first = useFileTree.getState().loadRoots(api);
    const second = useFileTree.getState().loadRoots(api);
    rootLoad.resolve({ entries: [{ name: "README.md", type: "file" }] });
    await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(useFileTree.getState().roots).toEqual([{ name: "README.md", type: "file" }]);
    expect(useFileTree.getState().loadingRoots).toBe(false);
  });

  it("keeps failed root loads retryable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ entries: [{ name: "README.md", type: "file" }] });
    const api = makeApi(get as never);

    await useFileTree.getState().loadRoots(api);
    expect(useFileTree.getState().roots).toBeNull();
    expect(useFileTree.getState().loadingRoots).toBe(false);

    await useFileTree.getState().loadRoots(api);
    expect(get).toHaveBeenCalledTimes(2);
    expect(useFileTree.getState().roots).toEqual([{ name: "README.md", type: "file" }]);
  });

  it("clears cached children and expansion state on forced root refresh", async () => {
    const get = vi.fn().mockResolvedValue({ entries: [{ name: "README.md", type: "file" }] });
    const api = makeApi(get as never);
    useFileTree.setState({
      roots: [{ name: "src", type: "directory" }],
      childrenByPath: { src: [{ name: "stale.ts", type: "file" }] },
      expanded: { src: true },
      loadingPaths: { src: true },
    });

    await useFileTree.getState().loadRoots(api, true);

    expect(useFileTree.getState().roots).toEqual([{ name: "README.md", type: "file" }]);
    expect(useFileTree.getState().childrenByPath).toEqual({});
    expect(useFileTree.getState().expanded).toEqual({});
    expect(useFileTree.getState().loadingPaths).toEqual({});
  });

  it("coalesces concurrent child loads for the same directory", async () => {
    const childLoad = deferred<{ entries: unknown[] }>();
    const get = vi.fn(() => childLoad.promise);
    const api = makeApi(get as never);

    const first = useFileTree.getState().toggle(api, "src");
    const second = useFileTree.getState().toggle(api, "src");
    childLoad.resolve({ entries: [{ name: "index.ts", type: "file" }] });
    await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(useFileTree.getState().childrenByPath.src).toEqual([
      { name: "index.ts", type: "file" },
    ]);
    expect(useFileTree.getState().loadingPaths.src).toBe(false);
  });

  it("keeps failed child loads retryable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ entries: [{ name: "index.ts", type: "file" }] });
    const api = makeApi(get as never);

    await useFileTree.getState().toggle(api, "src");
    expect(useFileTree.getState().childrenByPath.src).toBeUndefined();
    expect(useFileTree.getState().loadingPaths.src).toBe(false);

    await useFileTree.getState().toggle(api, "src");
    await useFileTree.getState().toggle(api, "src");

    expect(get).toHaveBeenCalledTimes(2);
    expect(useFileTree.getState().childrenByPath.src).toEqual([
      { name: "index.ts", type: "file" },
    ]);
  });
});
