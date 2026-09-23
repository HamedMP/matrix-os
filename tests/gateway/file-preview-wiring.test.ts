import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingAgentFilePreviewWiring } from "../../packages/gateway/src/coding-agents/file-preview-wiring.js";

describe("coding agent file preview wiring", () => {
  let homePath: string;

  afterEach(async () => {
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  it("shares owner authorization between file access and preview routes", async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-preview-wiring-"));
    await writeFile(join(homePath, "generated.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const { filePreviewService, codingAgentFileStore } = createCodingAgentFilePreviewWiring({
      homePath,
      ownerId: "owner",
    });

    const owner = { userId: "owner", source: "jwt" as const };
    const other = { userId: "other", source: "jwt" as const };
    await expect(filePreviewService.resolvePreview(owner, { kind: "home", path: "generated.png" }))
      .resolves.toMatchObject({ kind: "image", mimeType: "image/png" });
    await expect(filePreviewService.resolvePreview(other, { kind: "home", path: "generated.png" }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(codingAgentFileStore.readFile(other, { projectId: "demo", path: "generated.png" }))
      .rejects.toMatchObject({ code: "file_not_found" });
  });
});
