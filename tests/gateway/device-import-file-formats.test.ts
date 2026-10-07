import { describe, expect, it } from "vitest";
import { getMimeType, isTextFile, isBinaryFile } from "../../packages/gateway/src/file-utils.js";
import { classifyFilePreview } from "../../packages/contracts/src/file-preview.js";

describe("selected export and phone-photo formats", () => {
  it("makes completed-game PGN exports readable through the existing file preview", () => {
    expect(getMimeType(".pgn")).toBe("text/plain");
    expect(isTextFile("game.pgn")).toBe(true);
    expect(classifyFilePreview({ name: "game.pgn" })).toBe("text");
  });
  it("preserves HEIC/HEIF phone-photo MIME types instead of exposing binary text", () => {
    expect(getMimeType(".heic")).toBe("image/heic");
    expect(getMimeType(".heif")).toBe("image/heif");
    expect(isBinaryFile("photo.heic")).toBe(true);
  });
});
