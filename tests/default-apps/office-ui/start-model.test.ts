import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SYSTEM_ROOT_DIRS,
  breadcrumbTrail,
  browsableEntries,
  createStartFolderMemory,
  hiddenSystemCount,
  normalizeStartDir,
  startDirCandidates,
  filterEntries,
  folderLabel,
  relativeTime,
  sortEntries,
  typedTarget,
  type StartFileEntry,
} from "../../../home/apps/_shared/office-ui/start-model";

describe("typedTarget", () => {
  it("opens a typed name with an accepted extension as that file only", () => {
    expect(typedTarget("work", "  Q3 Plan.DOCX ", [".docx"])).toEqual({ name: "Q3 Plan.DOCX", files: ["work/Q3 Plan.DOCX"], folder: null });
    expect(typedTarget("", "top.docx", [".docx"])).toEqual({ name: "top.docx", files: ["top.docx"], folder: null });
  });

  it("tries each accepted extension, then a folder, for a name without one", () => {
    expect(typedTarget("work", "budget", [".xlsx", ".csv"])).toEqual({ name: "budget", files: ["work/budget.xlsx", "work/budget.csv"], folder: "work/budget" });
    expect(typedTarget("work", "notes.md", [".docx"])).toEqual({ name: "notes.md", files: ["work/notes.md.docx"], folder: "work/notes.md" });
  });

  it("refuses text that is not one plain, visible name", () => {
    for (const query of ["", "   ", "a/b.docx", "a\\b.docx", ".", "..", ".hidden.docx", "~$lock.docx", "bad\0.docx", "x".repeat(256)]) {
      expect(typedTarget("work", query, [".docx"])).toBeNull();
    }
    expect(typedTarget("", "system", [".docx"])).toBeNull();
    expect(typedTarget("", "agents", [".docx"])).toBeNull();
    expect(typedTarget("projects", "system", [".docx"])?.folder).toBe("projects/system");
  });
});

function entry(path: string, kind: "file" | "dir" = "file", modifiedAt = "2026-11-20T09:00:00.000Z"): StartFileEntry {
  return { name: path.split("/").pop() ?? path, path, kind, size: 0, modifiedAt };
}

describe("browsableEntries", () => {
  it("keeps folders and accepted file types, and drops hidden, lock and protected entries", () => {
    const entries = [
      entry("system", "dir"),
      entry("agents", "dir"),
      entry(".cache", "dir"),
      entry("documents", "dir"),
      entry("Plan.DOCX"),
      entry("~$Plan.docx"),
      entry("notes.md"),
      entry("budget.xlsx"),
    ];
    expect(browsableEntries("", entries, [".docx"]).map((item) => item.name)).toEqual(["documents", "Plan.DOCX"]);
    expect(browsableEntries("", entries, [".xlsx", ".csv"]).map((item) => item.name)).toEqual(["documents", "budget.xlsx"]);
  });

  it("only hides the protected names at the top of the home", () => {
    expect(browsableEntries("projects", [entry("projects/system", "dir")], [".docx"])).toHaveLength(1);
  });
});

describe("Matrix system folders", () => {
  const root = ["apps", "app-templates", "data", "modules", "plugins", "sessions", "templates", "temporary", "themes", "tools", "documents", "projects"].map((name) => entry(name, "dir"));

  it("hides them at the top of the home and keeps the owner's folders", () => {
    expect(browsableEntries("", root, [".docx"]).map((item) => item.name)).toEqual(["documents", "projects"]);
    expect(hiddenSystemCount("", root)).toBe(10);
  });

  it("shows the readable ones on request, and never the protected ones", () => {
    const shown = browsableEntries("", [...root, entry("system", "dir"), entry("agents", "dir"), entry(".ssh", "dir")], [".docx"], { showSystem: true }).map((item) => item.name);
    expect(shown).toContain("apps");
    expect(shown).not.toContain("system");
    expect(shown).not.toContain("agents");
    expect(shown).not.toContain(".ssh");
  });

  it("only applies at the top of the home", () => {
    expect(browsableEntries("projects", [entry("projects/apps", "dir")], [".docx"])).toHaveLength(1);
    expect(hiddenSystemCount("projects", [entry("projects/apps", "dir")])).toBe(0);
  });

  it("covers every folder the home template ships except the owner's projects, and the Files app's system places", () => {
    const template = readdirSync(join(__dirname, "../../../home"), { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith(".") && item.name !== "projects")
      .map((item) => item.name);
    expect(template.length).toBeGreaterThan(5);
    for (const name of template) expect(SYSTEM_ROOT_DIRS.has(name), name).toBe(true);
    // The Files app's own list of system places, read as text because the module imports shell-only icons.
    const places = [...readFileSync(join(__dirname, "../../../shell/src/components/file-browser/file-browser-locations.ts"), "utf8").matchAll(/path: "([^"]+)"/g)].map((match) => match[1]);
    expect(places.length).toBeGreaterThan(3);
    for (const place of places) expect(SYSTEM_ROOT_DIRS.has(place), place).toBe(true);
    expect(SYSTEM_ROOT_DIRS.has("documents")).toBe(false);
    expect(SYSTEM_ROOT_DIRS.has("projects")).toBe(false);
  });
});

describe("the folder the browser starts in", () => {
  it("accepts only a plain home-relative folder", () => {
    expect(normalizeStartDir("documents/legal")).toBe("documents/legal");
    expect(normalizeStartDir("documents/legal/")).toBe("documents/legal");
    expect(normalizeStartDir("")).toBe("");
    for (const bad of ["/etc", "a/../b", "..", "a//b", "a\\b", "system/x", "agents", ".ssh", "a/.git", "x".repeat(2000), 4, null, undefined]) {
      expect(normalizeStartDir(bad), String(bad)).toBeNull();
    }
  });

  it("tries the remembered folder, then documents, then the home", () => {
    expect(startDirCandidates("work/q3")).toEqual(["work/q3", "documents", ""]);
    expect(startDirCandidates(null)).toEqual(["documents", ""]);
    expect(startDirCandidates("documents")).toEqual(["documents", ""]);
    expect(startDirCandidates("")).toEqual([""]);
  });

  it("keeps the folder in the app's own store and survives a store that fails", async () => {
    const store = new Map<string, unknown>();
    const bridge = {
      readData: vi.fn(async (key: string) => store.get(key) ?? null),
      writeData: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
    };
    const memory = createStartFolderMemory(bridge);
    expect(await memory?.read()).toBeNull();
    await memory?.write("work/q3");
    expect(store.get("start_folder")).toEqual({ dir: "work/q3" });
    expect(await memory?.read()).toBe("work/q3");
    store.set("start_folder", { dir: "../../etc" });
    expect(await memory?.read()).toBeNull();

    const log = vi.fn();
    const broken = createStartFolderMemory({ readData: async () => Promise.reject(new Error("down")), writeData: async () => Promise.reject(new Error("down")) }, log);
    expect(await broken?.read()).toBeNull();
    await broken?.write("a");
    expect(log).toHaveBeenCalledTimes(2);
    expect(createStartFolderMemory({})).toBeUndefined();
    expect(createStartFolderMemory(null)).toBeUndefined();
  });
});

describe("sortEntries and filterEntries", () => {
  const list = [entry("b 10.docx", "file", "2026-11-01T00:00:00Z"), entry("b 9.docx", "file", "2026-11-03T00:00:00Z"), entry("zeta", "dir"), entry("Alpha", "dir")];

  it("puts folders first and sorts names naturally", () => {
    expect(sortEntries(list, "name").map((item) => item.name)).toEqual(["Alpha", "zeta", "b 9.docx", "b 10.docx"]);
  });

  it("sorts files newest first when asked", () => {
    expect(sortEntries(list, "modified").map((item) => item.name)).toEqual(["Alpha", "zeta", "b 9.docx", "b 10.docx"]);
    expect(sortEntries([list[1], list[0]], "modified").map((item) => item.name)).toEqual(["b 9.docx", "b 10.docx"]);
  });

  it("matches every word of the query, ignoring case", () => {
    const files = [entry("Q3 board report.docx"), entry("Q3 notes.docx"), entry("report.docx")];
    expect(filterEntries(files, "REPORT q3").map((item) => item.name)).toEqual(["Q3 board report.docx"]);
    expect(filterEntries(files, "   ")).toHaveLength(3);
  });
});

describe("breadcrumbTrail and folderLabel", () => {
  it("builds the path from the home", () => {
    expect(breadcrumbTrail("documents/legal")).toEqual([
      { label: "Home", path: "" },
      { label: "documents", path: "documents" },
      { label: "legal", path: "documents/legal" },
    ]);
    expect(folderLabel("documents/legal/msa.docx")).toBe("documents / legal");
    expect(folderLabel("top.docx")).toBe("Home");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-25T15:00:00");
  it("reads like speech for recent times and falls back to a date", () => {
    expect(relativeTime(new Date(now - 20_000).toISOString(), now, "en")).toBe("Just now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now, "en")).toBe("5 minutes ago");
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now, "en")).toBe("3 hours ago");
    expect(relativeTime(new Date(Date.parse("2026-11-24T09:00:00")).toISOString(), now, "en")).toBe("Yesterday");
    expect(relativeTime(new Date(Date.parse("2026-11-21T09:00:00")).toISOString(), now, "en")).toBe("4 days ago");
    expect(relativeTime(new Date(Date.parse("2026-10-02T09:00:00")).toISOString(), now, "en")).toBe("Oct 2");
    expect(relativeTime(new Date(Date.parse("2025-10-02T09:00:00")).toISOString(), now, "en")).toBe("Oct 2, 2025");
    expect(relativeTime("not a time", now)).toBe("");
  });
});
