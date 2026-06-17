import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbedManager,
  MAX_TOTAL_EMBEDS,
  type Bounds,
  type EmbedViewLike,
} from "@desktop/main/embeds/embed-manager";

const BOUNDS: Bounds = { x: 0, y: 0, width: 800, height: 600 };

class FakeView implements EmbedViewLike {
  events: string[] = [];
  loadedUrls: string[] = [];
  bounds: Bounds | null = null;
  failNextLoadError: unknown;
  onState: (state: "loading" | "ready" | "failed") => void;

  constructor(
    failNextLoadError: unknown = null,
    onState: (state: "loading" | "ready" | "failed") => void = () => undefined,
  ) {
    this.failNextLoadError = failNextLoadError;
    this.onState = onState;
  }

  setBounds(bounds: Bounds): void {
    this.bounds = bounds;
    this.events.push("setBounds");
  }

  async loadUrl(url: string): Promise<void> {
    this.events.push(`load:${url}`);
    this.loadedUrls.push(url);
    if (this.failNextLoadError) {
      const err = this.failNextLoadError;
      this.failNextLoadError = null;
      throw err;
    }
  }

  attach(): void {
    this.events.push("attach");
  }

  detach(): void {
    this.events.push("detach");
  }

  destroy(): void {
    this.events.push("destroy");
  }

  emit(state: "loading" | "ready" | "failed"): void {
    this.onState(state);
  }
}

function makeManager(maxLive?: number) {
  const views: Array<{ partition: string; view: FakeView }> = [];
  let nextCreatedLoadError: unknown = null;
  const manager = new EmbedManager({
    createView: ({ partition, onState }) => {
      const view = new FakeView(nextCreatedLoadError, onState);
      nextCreatedLoadError = null;
      views.push({ partition, view });
      return view;
    },
    allowedOrigins: ["https://gw.test"],
    ...(maxLive === undefined ? {} : { maxLive }),
  });
  return {
    manager,
    views,
    failNextCreatedLoad: () => {
      nextCreatedLoadError = new Error("load failed");
    },
    failNextCreatedLoadWith: (err: unknown) => {
      nextCreatedLoadError = err;
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmbedManager", () => {
  it("names partitions persist:hosted-shell and persist:app-<slug>", () => {
    const { manager, views } = makeManager();
    manager.open("hosted-shell", null, BOUNDS, "https://gw.test/canvas");
    manager.open("app", "notes", BOUNDS, "https://gw.test/apps/notes/");
    expect(views.map((v) => v.partition)).toEqual(["persist:hosted-shell", "persist:app-notes"]);
  });

  it("rejects app embeds without a safe slug", () => {
    const { manager } = makeManager();
    expect(() => manager.open("app", null, BOUNDS, "https://gw.test/")).toThrow();
    expect(() => manager.open("app", "../evil", BOUNDS, "https://gw.test/")).toThrow();
    expect(() => manager.open("app", "a b", BOUNDS, "https://gw.test/")).toThrow();
  });

  it("rejects embeds outside the allowed origin before creating a view", () => {
    const { manager, views } = makeManager();

    expect(() => manager.open("app", "notes", BOUNDS, "https://evil.test/apps/notes/")).toThrow(
      /not allowed/,
    );
    expect(() => manager.open("hosted-shell", null, BOUNDS, "file:///tmp/index.html")).toThrow(
      /not allowed/,
    );
    expect(views).toHaveLength(0);
  });

  it("uses the latest allowed origins when opening after a runtime switch", () => {
    const views: Array<{ partition: string; view: FakeView }> = [];
    let gatewayOrigin = "https://first-gw.test";
    const manager = new EmbedManager({
      getAllowedOrigins: () => [gatewayOrigin],
      createView: ({ partition, onState }) => {
        const view = new FakeView(null, onState);
        views.push({ partition, view });
        return view;
      },
    });

    const first = manager.open("hosted-shell", null, BOUNDS, "https://first-gw.test/canvas");
    manager.closeAll();
    gatewayOrigin = "https://second-gw.test";
    const second = manager.open("hosted-shell", null, BOUNDS, "https://second-gw.test/canvas");

    expect(first).not.toBe(second);
    expect(views.map((entry) => entry.view.loadedUrls)).toEqual([
      ["https://first-gw.test/canvas"],
      ["https://second-gw.test/canvas"],
    ]);
    expect(() =>
      manager.open("hosted-shell", null, BOUNDS, "https://first-gw.test/canvas"),
    ).toThrow(/not allowed/);
  });

  it("attaches, sizes, and loads new embeds", () => {
    const { manager, views } = makeManager();
    const id = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/canvas");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(manager.has(id)).toBe(true);
    expect(manager.liveCount).toBe(1);
    const view = views[0]?.view;
    expect(view?.events).toContain("attach");
    expect(view?.loadedUrls).toEqual(["https://gw.test/canvas"]);
    expect(view?.bounds).toEqual(BOUNDS);
  });

  it("propagates adapter lifecycle states to the caller", () => {
    const { manager, views } = makeManager();
    const states: string[] = [];
    manager.open("hosted-shell", null, BOUNDS, "https://gw.test/canvas", {
      onState: (state) => states.push(state),
    });

    views[0]?.view.emit("loading");
    views[0]?.view.emit("ready");

    expect(states).toEqual(["loading", "ready"]);
  });

  it("returns unique embed ids", () => {
    const { manager } = makeManager();
    const a = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/");
    const b = manager.open("app", "notes", BOUNDS, "https://gw.test/");
    expect(a).not.toBe(b);
  });

  it("suspends the least-recently-used live embed beyond maxLive", () => {
    const { manager, views } = makeManager(2);
    manager.open("app", "a", BOUNDS, "https://gw.test/a");
    manager.open("app", "b", BOUNDS, "https://gw.test/b");
    manager.open("app", "c", BOUNDS, "https://gw.test/c");
    expect(manager.liveCount).toBe(2);
    expect(views[0]?.view.events).toContain("detach");
    expect(views[1]?.view.events).not.toContain("detach");
    expect(views[2]?.view.events).not.toContain("detach");
  });

  it("rejects maxLive values above the total embed cap", () => {
    expect(() => makeManager(MAX_TOTAL_EMBEDS + 1)).toThrow(/maxLive/);
  });

  it("focus bumps recency so the LRU choice changes", () => {
    const { manager, views } = makeManager(2);
    const a = manager.open("app", "a", BOUNDS, "https://gw.test/a");
    manager.open("app", "b", BOUNDS, "https://gw.test/b");
    expect(manager.focus(a)).toBe(true);
    manager.open("app", "c", BOUNDS, "https://gw.test/c");
    expect(views[1]?.view.events).toContain("detach");
    expect(views[0]?.view.events).not.toContain("detach");
  });

  it("focus resumes a suspended embed without an unnecessary reload", () => {
    const { manager, views } = makeManager(2);
    const a = manager.open("app", "a", BOUNDS, "https://gw.test/a");
    manager.open("app", "b", BOUNDS, "https://gw.test/b");
    manager.open("app", "c", BOUNDS, "https://gw.test/c");
    const viewA = views[0]?.view;
    expect(viewA?.events).toContain("detach");

    expect(manager.focus(a)).toBe(true);
    expect(manager.liveCount).toBe(2);
    expect(viewA?.events.filter((e) => e === "attach")).toHaveLength(2);
    expect(viewA?.loadedUrls).toHaveLength(1);
    // Resuming pushed the new LRU live embed (b) out.
    expect(views[1]?.view.events).toContain("detach");
  });

  it("reloads on focus when the initial load failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager, views, failNextCreatedLoad } = makeManager();
    failNextCreatedLoad();
    const id = manager.open("app", "notes", BOUNDS, "https://gw.test/apps/notes/");
    await flush();
    expect(manager.focus(id)).toBe(true);
    expect(views[0]?.view.loadedUrls).toEqual([
      "https://gw.test/apps/notes/",
      "https://gw.test/apps/notes/",
    ]);
  });

  it("reload emits loading and reloads the current url", async () => {
    const { manager, views } = makeManager();
    const states: string[] = [];
    const id = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/", {
      onState: (state) => states.push(state),
    });

    expect(manager.reload(id)).toBe(true);
    await flush();

    expect(states).toEqual(["loading"]);
    expect(views[0]?.view.loadedUrls).toEqual(["https://gw.test/", "https://gw.test/"]);
  });

  it("ignores stale loadUrl failures after a newer reload starts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const states: string[] = [];
    let rejectFirst!: (err: unknown) => void;
    let loadCount = 0;
    const manager = new EmbedManager({
      allowedOrigins: ["https://gw.test"],
      createView: () => ({
        setBounds: () => undefined,
        loadUrl: async () => {
          loadCount += 1;
          if (loadCount === 1) {
            return new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            });
          }
        },
        attach: () => undefined,
        detach: () => undefined,
        destroy: () => undefined,
      }),
    });
    const id = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/", {
      onState: (state) => states.push(state),
    });

    expect(manager.reload(id)).toBe(true);
    rejectFirst(new Error("stale navigation failed"));
    await flush();

    expect(states).toEqual(["loading"]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not mark aborted loadURL redirects as failed", async () => {
    const { manager, views, failNextCreatedLoadWith } = makeManager();
    const states: string[] = [];
    failNextCreatedLoadWith(Object.assign(new Error("ERR_ABORTED"), { errno: -3 }));
    const id = manager.open("app", "notes", BOUNDS, "https://gw.test/apps/notes/", {
      onState: (state) => states.push(state),
    });
    await flush();
    expect(states).toEqual([]);

    expect(manager.focus(id)).toBe(true);
    expect(views[0]?.view.loadedUrls).toEqual(["https://gw.test/apps/notes/"]);
  });

  it("emits one failed state when the adapter reports failure and loadUrl rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const states: string[] = [];
    const manager = new EmbedManager({
      allowedOrigins: ["https://gw.test"],
      createView: ({ onState }) => ({
        setBounds: () => undefined,
        loadUrl: async () => {
          onState("failed");
          throw new Error("main frame failed");
        },
        attach: () => undefined,
        detach: () => undefined,
        destroy: () => undefined,
      }),
    });

    manager.open("app", "notes", BOUNDS, "https://gw.test/apps/notes/", {
      onState: (state) => states.push(state),
    });
    await flush();

    expect(states).toEqual(["failed"]);
  });

  it("updates bounds for live embeds", () => {
    const { manager, views } = makeManager();
    const id = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/");
    const next = { x: 10, y: 20, width: 400, height: 300 };
    expect(manager.setBounds(id, next)).toBe(true);
    expect(views[0]?.view.bounds).toEqual(next);
  });

  it("close destroys the view and forgets the embed", () => {
    const { manager, views } = makeManager();
    const id = manager.open("hosted-shell", null, BOUNDS, "https://gw.test/");
    expect(manager.close(id)).toBe(true);
    expect(views[0]?.view.events).toEqual([
      "attach",
      "setBounds",
      "load:https://gw.test/",
      "detach",
      "destroy",
    ]);
    expect(manager.has(id)).toBe(false);
    expect(manager.liveCount).toBe(0);
    expect(manager.close(id)).toBe(false);
  });

  it("returns false for unknown embed ids", () => {
    const { manager } = makeManager();
    expect(manager.focus("nope")).toBe(false);
    expect(manager.setBounds("nope", BOUNDS)).toBe(false);
    expect(manager.close("nope")).toBe(false);
    expect(manager.has("nope")).toBe(false);
  });

  it("closeAll destroys every embed including suspended ones", () => {
    const { manager, views } = makeManager(1);
    manager.open("app", "a", BOUNDS, "https://gw.test/a");
    manager.open("app", "b", BOUNDS, "https://gw.test/b");
    manager.closeAll();
    expect(manager.liveCount).toBe(0);
    expect(views[0]?.view.events).toEqual([
      "attach",
      "setBounds",
      "load:https://gw.test/a",
      "detach",
      "destroy",
    ]);
    expect(views[1]?.view.events).toEqual([
      "attach",
      "setBounds",
      "load:https://gw.test/b",
      "detach",
      "destroy",
    ]);
  });

  it("caps total records and evicts the LRU suspended embed entirely", () => {
    const { manager, views } = makeManager(2);
    const ids: string[] = [];
    for (let i = 0; i <= MAX_TOTAL_EMBEDS; i++) {
      ids.push(manager.open("app", `app-${i}`, BOUNDS, `https://gw.test/app-${i}`));
    }
    expect(manager.has(ids[0] ?? "")).toBe(false);
    expect(views[0]?.view.events).toContain("destroy");
    expect(manager.has(ids[1] ?? "")).toBe(true);
    expect(manager.liveCount).toBe(2);
  });
});
