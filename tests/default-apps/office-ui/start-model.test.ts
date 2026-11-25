import { describe, expect, it } from "vitest";
import {
  breadcrumbTrail,
  browsableEntries,
  filterEntries,
  folderLabel,
  relativeTime,
  sortEntries,
  type StartFileEntry,
} from "../../../home/apps/_shared/office-ui/start-model";

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
