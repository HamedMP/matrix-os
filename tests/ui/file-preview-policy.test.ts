import { describe, expect, it } from "vitest";
import {
  filePreviewContentUrl,
  filePreviewMetadataUrl,
} from "../../packages/ui/src/files/file-preview-policy";

describe("file preview URL policy", () => {
  it("serializes every authorized resource scope without leaking host paths", () => {
    expect(filePreviewContentUrl({ kind: "home", path: "data/chat-artifacts/image.png" }))
      .toBe("/api/file-previews/content?kind=home&path=data%2Fchat-artifacts%2Fimage.png");
    expect(filePreviewMetadataUrl({
      kind: "project",
      projectId: "matrix-os",
      worktreeId: "review-1844",
      path: "reports/result.pdf",
    })).toBe("/api/file-previews/metadata?kind=project&projectId=matrix-os&worktreeId=review-1844&path=reports%2Fresult.pdf");
    expect(filePreviewContentUrl({ kind: "artifact", chatId: "chat_1", artifactId: "artifact_1" }, { download: true }))
      .toBe("/api/file-previews/content?kind=artifact&chatId=chat_1&artifactId=artifact_1&download=true");
  });
});
