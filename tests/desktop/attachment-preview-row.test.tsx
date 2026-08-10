// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreviewRow } from "../../desktop/src/renderer/src/features/chat/attachments/AttachmentPreviewRow";
import type { LocalConversationAttachment } from "../../desktop/src/renderer/src/features/chat/attachments/local-attachment-controller";

function item(index: number, overrides: Partial<LocalConversationAttachment> = {}): LocalConversationAttachment {
  return {
    localId: `local_${index}`,
    uploadId: `upload_${index}`,
    uploadPath: `uploads/desktop-chat/upload_${index}-file-${index}.txt`,
    file: new File(["x"], `file-${index}.txt`, { type: "text/plain" }),
    status: "ready",
    ...overrides,
  };
}

afterEach(cleanup);

describe("AttachmentPreviewRow", () => {
  it("renders at most eight previews in one horizontal non-wrapping row", () => {
    render(<AttachmentPreviewRow items={Array.from({ length: 9 }, (_, index) => item(index))} onRemove={vi.fn()} onRetry={vi.fn()} />);

    const group = screen.getByRole("group", { name: "Attachments" });
    expect(group.className).toContain("overflow-x-auto");
    expect(group.className).not.toContain("flex-wrap");
    expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(8);
  });

  it("uses safe raster thumbnails and gives Retry and Remove equal-size actions", () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    render(<AttachmentPreviewRow
      items={[
        item(1, { file: new File(["png"], "screen.png", { type: "image/png" }), previewUrl: "blob:safe" }),
        item(2, { file: new File(["svg"], "vector.svg", { type: "image/svg+xml" }), previewUrl: undefined }),
        item(3, { status: "failed", error: "Upload failed. Try again." }),
      ]}
      onRemove={onRemove}
      onRetry={onRetry}
    />);

    expect(screen.getByRole("img", { name: "screen.png" }).getAttribute("src")).toBe("blob:safe");
    expect(screen.queryByRole("img", { name: "vector.svg" })).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry file-3.txt" });
    const remove = screen.getByRole("button", { name: "Remove file-3.txt" });
    expect(retry.className).toContain("h-6 w-6");
    expect(remove.className).toContain("h-6 w-6");
    expect(retry.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(remove.querySelector("svg")?.getAttribute("width")).toBe("14");
    fireEvent.click(screen.getByRole("button", { name: "Remove screen.png" }));
    fireEvent.click(retry);
    expect(onRemove).toHaveBeenCalledWith("local_1");
    expect(onRetry).toHaveBeenCalledWith("local_3");
  });

  it("disables Retry and Remove while the composer is submitting", () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    render(<AttachmentPreviewRow
      items={[item(1, { status: "failed", error: "Upload failed. Try again." })]}
      disabled
      onRemove={onRemove}
      onRetry={onRetry}
    />);

    const retry = screen.getByRole("button", { name: "Retry file-1.txt" });
    const remove = screen.getByRole("button", { name: "Remove file-1.txt" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(remove);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
