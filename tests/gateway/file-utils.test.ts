import { describe, it, expect } from "vitest";
import { getMimeType, isTextFile, isBinaryFile } from "../../packages/gateway/src/file-utils.js";

describe("getMimeType", () => {
  it("returns correct MIME for markdown", () => {
    expect(getMimeType(".md")).toBe("text/markdown");
  });

  it("returns correct MIME for images", () => {
    expect(getMimeType(".png")).toBe("image/png");
    expect(getMimeType(".jpg")).toBe("image/jpeg");
    expect(getMimeType(".svg")).toBe("image/svg+xml");
  });

  it("returns correct MIME for code files", () => {
    expect(getMimeType(".ts")).toBe("text/typescript");
    expect(getMimeType(".py")).toBe("text/x-python");
    expect(getMimeType(".js")).toBe("text/javascript");
    expect(getMimeType(".html")).toBe("text/html");
    expect(getMimeType(".css")).toBe("text/css");
  });

  it("returns correct MIME for data files", () => {
    expect(getMimeType(".json")).toBe("application/json");
    expect(getMimeType(".yaml")).toBe("text/yaml");
    expect(getMimeType(".yml")).toBe("text/yaml");
    expect(getMimeType(".toml")).toBe("text/toml");
    expect(getMimeType(".csv")).toBe("text/csv");
  });

  it("returns correct MIME for media files", () => {
    expect(getMimeType(".mp3")).toBe("audio/mpeg");
    expect(getMimeType(".wav")).toBe("audio/wav");
    expect(getMimeType(".mp4")).toBe("video/mp4");
    expect(getMimeType(".webm")).toBe("video/webm");
  });

  it("returns octet-stream for unknown", () => {
    expect(getMimeType(".xyz")).toBe("application/octet-stream");
    expect(getMimeType(".bin")).toBe("application/octet-stream");
  });

  it("handles with or without leading dot", () => {
    expect(getMimeType("md")).toBe("text/markdown");
    expect(getMimeType(".md")).toBe("text/markdown");
    expect(getMimeType("png")).toBe("image/png");
  });

  it("is case insensitive", () => {
    expect(getMimeType(".MD")).toBe("text/markdown");
    expect(getMimeType(".PNG")).toBe("image/png");
    expect(getMimeType(".Json")).toBe("application/json");
  });
});

describe("isTextFile", () => {
  it("recognizes text files", () => {
    expect(isTextFile("readme.md")).toBe(true);
    expect(isTextFile("config.json")).toBe(true);
    expect(isTextFile("app.tsx")).toBe(true);
    expect(isTextFile("style.css")).toBe(true);
    expect(isTextFile("script.sh")).toBe(true);
    expect(isTextFile("data.yaml")).toBe(true);
    expect(isTextFile("notes.txt")).toBe(true);
  });

  it("rejects binary files", () => {
    expect(isTextFile("photo.png")).toBe(false);
    expect(isTextFile("doc.pdf")).toBe(false);
    expect(isTextFile("song.mp3")).toBe(false);
    expect(isTextFile("video.mp4")).toBe(false);
  });

  it("rejects unknown extensions", () => {
    expect(isTextFile("file.xyz")).toBe(false);
  });
});

describe("isBinaryFile", () => {
  it("recognizes binary files", () => {
    expect(isBinaryFile("photo.png")).toBe(true);
    expect(isBinaryFile("photo.jpg")).toBe(true);
    expect(isBinaryFile("doc.pdf")).toBe(true);
    expect(isBinaryFile("song.mp3")).toBe(true);
    expect(isBinaryFile("clip.mp4")).toBe(true);
  });

  it("rejects text files", () => {
    expect(isBinaryFile("readme.md")).toBe(false);
    expect(isBinaryFile("config.json")).toBe(false);
  });

  it("rejects unknown extensions", () => {
    expect(isBinaryFile("file.xyz")).toBe(false);
  });
});
