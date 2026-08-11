// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  createFileDragSession,
  FILE_MOVE_MIME,
  isValidFileDropTarget,
  MAX_FILE_DRAG_BYTES,
  mountFileDragPreview,
  readFileDragData,
  writeFileDragData,
} from "@desktop/renderer/src/features/files/file-drag";
import { createFileSelection, updateFileSelection } from "@desktop/renderer/src/features/files/file-selection";

const scope = { directory: "projects", runtimeSlot: "primary", authGeneration: 3 };

function dragTransfer(types: string[] = []) {
  const values: Record<string, string> = {};
  return {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    files: [] as unknown as FileList,
    get types() { return types.length ? types : Object.keys(values); },
    getData: vi.fn((type: string) => values[type] ?? ""),
    setData: vi.fn((type: string, value: string) => { values[type] = value; }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

describe("internal Files drag payload", () => {
  it("round-trips normalized selected siblings through the one internal MIME type", () => {
    const transfer = dragTransfer();

    expect(writeFileDragData(transfer, ["projects/a.md", "projects/b.md"], scope)).toBe(true);
    expect(transfer.effectAllowed).toBe("move");
    expect(transfer.setData).toHaveBeenCalledWith(FILE_MOVE_MIME, expect.any(String));
    expect(readFileDragData(transfer, scope)).toEqual({
      version: 1,
      paths: ["projects/a.md", "projects/b.md"],
      scope,
    });
  });

  it("drags an already selected row as the ordered selection with focused preview text", () => {
    const selection = {
      ...createFileSelection(scope),
      selectedPaths: ["projects/a.md", "projects/b.md"],
      anchorPath: "projects/a.md",
      focusedPath: "projects/b.md",
    };

    expect(createFileDragSession(selection, "projects/a.md")).toEqual({
      selection,
      paths: ["projects/a.md", "projects/b.md"],
      preview: { label: "b.md", additionalCount: 1 },
    });
  });

  it("collapses an unselected drag row before building its preview", () => {
    const selection = {
      ...createFileSelection(scope),
      selectedPaths: ["projects/a.md", "projects/b.md"],
      anchorPath: "projects/a.md",
      focusedPath: "projects/b.md",
    };

    expect(createFileDragSession(selection, "projects/c.md")).toMatchObject({
      selection: {
        selectedPaths: ["projects/c.md"],
        anchorPath: "projects/c.md",
        focusedPath: "projects/c.md",
      },
      paths: ["projects/c.md"],
      preview: { label: "c.md", additionalCount: 0 },
    });
  });

  it("rejects path count, path bytes, duplicates, mixed parents, scope, and total bytes", () => {
    expect(writeFileDragData(dragTransfer(), Array.from({ length: 101 }, (_, index) => `projects/${index}`), scope)).toBe(false);
    expect(writeFileDragData(dragTransfer(), [`projects/${"é".repeat(2_050)}`], scope)).toBe(false);
    expect(writeFileDragData(dragTransfer(), ["projects/a", "projects/a"], scope)).toBe(false);
    expect(writeFileDragData(dragTransfer(), ["projects/a", "archive/b"], scope)).toBe(false);
    expect(writeFileDragData(dragTransfer(), ["projects/a"], { ...scope, runtimeSlot: "Preview Computer" })).toBe(false);
    const large = Array.from({ length: 35 }, (_, index) => `projects/${index}-${"x".repeat(3_800)}`);
    expect(writeFileDragData(dragTransfer(), large, scope)).toBe(false);
  });

  it("fails closed for malformed, oversized, external, unknown, and cross-scope drops", () => {
    const malformed = dragTransfer([FILE_MOVE_MIME]);
    vi.mocked(malformed.getData).mockReturnValue("{");
    expect(readFileDragData(malformed, scope)).toBeNull();

    const oversized = dragTransfer([FILE_MOVE_MIME]);
    vi.mocked(oversized.getData).mockReturnValue("x".repeat(MAX_FILE_DRAG_BYTES + 1));
    expect(readFileDragData(oversized, scope)).toBeNull();

    const external = dragTransfer(["Files"]);
    Object.defineProperty(external, "files", { value: { length: 1 } });
    expect(readFileDragData(external, scope)).toBeNull();
    expect(readFileDragData(dragTransfer(["text/plain"]), scope)).toBeNull();
    expect(readFileDragData(dragTransfer(["text/html"]), scope)).toBeNull();

    const unknownField = dragTransfer([FILE_MOVE_MIME]);
    vi.mocked(unknownField.getData).mockReturnValue(JSON.stringify({
      version: 1,
      paths: ["projects/a"],
      scope,
      overwrite: true,
    }));
    expect(readFileDragData(unknownField, scope)).toBeNull();

    const wrongVersion = dragTransfer([FILE_MOVE_MIME]);
    vi.mocked(wrongVersion.getData).mockReturnValue(JSON.stringify({
      version: 2,
      paths: ["projects/a"],
      scope,
    }));
    expect(readFileDragData(wrongVersion, scope)).toBeNull();

    const crossScope = dragTransfer();
    expect(writeFileDragData(crossScope, ["projects/a"], scope)).toBe(true);
    expect(readFileDragData(crossScope, { ...scope, authGeneration: 4 })).toBeNull();
  });

  it("preserves explicit mac Command and Windows Control selection before drag", () => {
    const order = ["projects/a.md", "projects/b.md"];
    const mac = updateFileSelection(
      updateFileSelection(createFileSelection(scope), order, order[0]!, {}, "mac"),
      order, order[1]!, { metaKey: true }, "mac",
    );
    const windows = updateFileSelection(
      updateFileSelection(createFileSelection(scope), order, order[0]!, {}, "windows"),
      order, order[1]!, { ctrlKey: true }, "windows",
    );

    expect(createFileDragSession(mac, order[1]!)?.paths).toEqual(order);
    expect(createFileDragSession(windows, order[1]!)?.paths).toEqual(order);
  });

  it("mounts at most one drag preview node and removes it deterministically", () => {
    const first = mountFileDragPreview(document, { label: "a.md", additionalCount: 0 });
    expect(document.querySelectorAll("[data-file-drag-preview]")).toHaveLength(1);
    expect(first.element.textContent).toBe("a.md");

    const second = mountFileDragPreview(document, { label: "b.md", additionalCount: 2 });
    expect(document.querySelectorAll("[data-file-drag-preview]")).toHaveLength(1);
    expect(document.body.contains(first.element)).toBe(false);
    expect(second.element.textContent).toBe("b.md+2");

    second.cleanup();
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    first.cleanup();
  });

  it("accepts a normalized destination and rejects current, source, and descendant targets", () => {
    const payload = {
      version: 1 as const,
      paths: ["projects/Folder", "projects/a.md"],
      scope,
    };

    expect(isValidFileDropTarget(payload, "archive")).toBe(true);
    expect(isValidFileDropTarget(payload, "projects")).toBe(false);
    expect(isValidFileDropTarget(payload, "projects/Folder")).toBe(false);
    expect(isValidFileDropTarget(payload, "projects/Folder/nested")).toBe(false);
  });
});
