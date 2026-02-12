import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface LayoutWindow {
  path: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "open" | "minimized" | "closed";
}

interface Layout {
  windows: LayoutWindow[];
}

function readLayout(homePath: string): Record<string, unknown> {
  const layoutPath = join(homePath, "system/layout.json");
  if (!existsSync(layoutPath)) return {};
  try {
    return JSON.parse(readFileSync(layoutPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeLayout(
  homePath: string,
  body: Record<string, unknown>,
): { ok: boolean; error?: string } {
  if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
    return { ok: false, error: "Invalid layout: requires windows array" };
  }
  const layoutPath = join(homePath, "system/layout.json");
  writeFileSync(layoutPath, JSON.stringify(body, null, 2));
  return { ok: true };
}

describe("Layout persistence", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "layout-test-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns {} when no layout file exists", () => {
    expect(readLayout(homePath)).toEqual({});
  });

  it("returns saved layout", () => {
    const layout: Layout = {
      windows: [
        {
          path: "modules/hello/index.html",
          title: "hello",
          x: 10,
          y: 20,
          width: 640,
          height: 480,
          state: "open",
        },
      ],
    };
    writeFileSync(
      join(homePath, "system/layout.json"),
      JSON.stringify(layout),
    );

    const data = readLayout(homePath) as Layout;
    expect(data.windows).toHaveLength(1);
    expect(data.windows[0].path).toBe("modules/hello/index.html");
  });

  it("returns {} on malformed JSON", () => {
    writeFileSync(join(homePath, "system/layout.json"), "not json{{{");
    expect(readLayout(homePath)).toEqual({});
  });

  it("writes layout to disk", () => {
    const layout: Layout = {
      windows: [
        {
          path: "apps/test.html",
          title: "test",
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          state: "open",
        },
      ],
    };

    const result = writeLayout(homePath, layout);
    expect(result.ok).toBe(true);

    const saved = JSON.parse(
      readFileSync(join(homePath, "system/layout.json"), "utf-8"),
    ) as Layout;
    expect(saved.windows).toHaveLength(1);
    expect(saved.windows[0].title).toBe("test");
  });

  it("rejects missing windows array", () => {
    const result = writeLayout(homePath, { something: "else" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("windows array");
  });

  it("rejects non-array windows", () => {
    const result = writeLayout(homePath, { windows: "not-an-array" });
    expect(result.ok).toBe(false);
  });

  it("round-trips layout through write then read", () => {
    const layout: Layout = {
      windows: [
        {
          path: "a.html",
          title: "a",
          x: 10,
          y: 20,
          width: 800,
          height: 600,
          state: "open",
        },
        {
          path: "b.html",
          title: "b",
          x: 100,
          y: 50,
          width: 640,
          height: 480,
          state: "minimized",
        },
        {
          path: "c.html",
          title: "c",
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          state: "closed",
        },
      ],
    };

    writeLayout(homePath, layout);

    const data = readLayout(homePath) as Layout;
    expect(data.windows).toHaveLength(3);
    expect(data.windows[0].state).toBe("open");
    expect(data.windows[1].state).toBe("minimized");
    expect(data.windows[2].state).toBe("closed");
  });

  it("preserves window positions and dimensions", () => {
    const layout: Layout = {
      windows: [
        {
          path: "test.html",
          title: "test",
          x: 123,
          y: 456,
          width: 789,
          height: 321,
          state: "open",
        },
      ],
    };

    writeLayout(homePath, layout);
    const data = readLayout(homePath) as Layout;
    const win = data.windows[0];
    expect(win.x).toBe(123);
    expect(win.y).toBe(456);
    expect(win.width).toBe(789);
    expect(win.height).toBe(321);
  });

  it("overwrites previous layout on write", () => {
    writeLayout(homePath, {
      windows: [{ path: "old.html", title: "old", x: 0, y: 0, width: 100, height: 100, state: "open" }],
    });

    writeLayout(homePath, {
      windows: [{ path: "new.html", title: "new", x: 50, y: 50, width: 200, height: 200, state: "open" }],
    });

    const data = readLayout(homePath) as Layout;
    expect(data.windows).toHaveLength(1);
    expect(data.windows[0].path).toBe("new.html");
  });
});
