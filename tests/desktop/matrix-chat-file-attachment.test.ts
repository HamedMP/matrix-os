// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginMatrixFileDrag,
  readMatrixFileAttachment,
  takeMatrixFileDrag,
} from "../../desktop/src/renderer/src/features/chat/attachments/matrix-file-attachment";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { MAX_AGENT_ATTACHMENT_BYTES } from "@matrix-os/contracts";

const resource = { kind: "project", projectId: "project", worktreeId: "wt_a", path: "docs/result.txt" } as const;

function transfer() {
  let value = "";
  return {
    effectAllowed: "all" as DataTransfer["effectAllowed"],
    getData: vi.fn(() => value),
    setData: vi.fn((_format, token: string) => { value = token; }),
  };
}

afterEach(() => useConnection.setState(useConnection.getInitialState(), true));

describe("Matrix Files attachment transfer", () => {
  it("accepts only the renderer's current, unused drag token", () => {
    const dataTransfer = transfer();
    const foreignTransfer = { getData: () => JSON.stringify(resource) };
    expect(takeMatrixFileDrag(foreignTransfer)).toBeNull();
    beginMatrixFileDrag(dataTransfer, resource);
    expect(dataTransfer.setData.mock.calls[0]?.[1]).not.toContain(resource.path);
    expect(takeMatrixFileDrag(dataTransfer)).toEqual(resource);
    expect(takeMatrixFileDrag(dataTransfer)).toBeNull();
  });

  it("rejects a drag from a previous computer or authentication generation", () => {
    const dataTransfer = transfer();
    beginMatrixFileDrag(dataTransfer, resource);
    useConnection.setState({ authGeneration: 9, runtimeSlot: "review" });
    expect(takeMatrixFileDrag(dataTransfer)).toBeNull();
  });

  it("retrieves the original bytes from the scoped worktree file endpoint", async () => {
    const blob = new Blob(["test contents"], { type: "text/plain" });
    const getBlob = vi.fn().mockResolvedValue(blob);
    const file = await readMatrixFileAttachment({ getBlob } as Pick<ApiClient, "getBlob">, resource, new AbortController().signal);
    expect(file).toMatchObject({ name: "result.txt", type: "text/plain", size: blob.size });
    expect(getBlob).toHaveBeenCalledWith(
      "/api/file-previews/content?kind=project&projectId=project&worktreeId=wt_a&path=docs%2Fresult.txt&download=true",
      { maxBytes: MAX_AGENT_ATTACHMENT_BYTES, signal: expect.any(AbortSignal) },
    );
  });

  it("discards a completed read after cancellation and rejects an invalid path", async () => {
    const controller = new AbortController();
    const getBlob = vi.fn(async () => {
      controller.abort();
      return new Blob(["stale"]);
    });
    await expect(readMatrixFileAttachment({ getBlob }, resource, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readMatrixFileAttachment({ getBlob }, { kind: "home", path: "../outside" }, new AbortController().signal)).rejects.toThrow();
    expect(getBlob).toHaveBeenCalledOnce();
  });
});
