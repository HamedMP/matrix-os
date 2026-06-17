import { afterEach, describe, expect, it } from "vitest";
import {
  clearFileBaselinesForTest,
  getFileBaseline,
  rememberFileBaseline,
} from "@desktop/renderer/src/features/editor/editor-baselines";

function file(path: string, content: string = path) {
  return { path, content, loadedMtime: "2026-06-17T00:00:00.000Z" };
}

afterEach(() => {
  clearFileBaselinesForTest();
});

describe("editor file baselines", () => {
  it("evicts the oldest entries beyond the baseline cap", () => {
    for (let i = 0; i < 65; i += 1) {
      rememberFileBaseline(`task\0file-${i}`, file(`file-${i}`));
    }

    expect(getFileBaseline("task\0file-0")).toBeUndefined();
    expect(getFileBaseline("task\0file-1")?.path).toBe("file-1");
    expect(getFileBaseline("task\0file-64")?.path).toBe("file-64");
  });

  it("refreshes recency when a baseline is read", () => {
    rememberFileBaseline("task\0keep", file("keep"));
    for (let i = 0; i < 63; i += 1) {
      rememberFileBaseline(`task\0file-${i}`, file(`file-${i}`));
    }
    expect(getFileBaseline("task\0keep")?.path).toBe("keep");

    rememberFileBaseline("task\0new", file("new"));

    expect(getFileBaseline("task\0file-0")).toBeUndefined();
    expect(getFileBaseline("task\0keep")?.path).toBe("keep");
  });
});
