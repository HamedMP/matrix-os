import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBlobRoutes } from "../../packages/gateway/src/file-blob-routes.js";

describe("selected device uploads", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "matrix-device-upload-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("never overwrites a concurrent upload and cleans staging files", async () => {
    const app = createFileBlobRoutes({ homePath: home });
    const responses = await Promise.all(["first", "second"].map(body => app.request(
      "/blob?path=export.csv", { method: "PUT", body },
    )));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.status === 200);
    expect(await readFile(join(home, "export.csv"), "utf8")).toBe(["first", "second"][winner]);
    expect(await readdir(home)).toEqual(["export.csv"]);
  });

  it.each(["bad\\name.csv", "bad\u0001.csv", "x".repeat(256), "../escape.csv"])(
    "rejects unsafe selected names at the route boundary: %s", async name => {
      const app = createFileBlobRoutes({ homePath: home });
      const response = await app.request(`/blob?path=${encodeURIComponent(name)}`, { method: "PUT", body: "x" });
      expect(response.status).toBe(400);
      expect(await readdir(home)).toEqual([]);
    },
  );

  it.each(["export.csv", "game.pgn", "photo.heic", "invoice.pdf"])("stores selected %s bytes without interpreting content", async name => {
    const app = createFileBlobRoutes({ homePath: home });
    const bytes = new Uint8Array([0, 127, 255]);
    const response = await app.request(`/blob?path=${name}`, { method: "PUT", body: bytes });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await readFile(join(home, name)))).toEqual(bytes);
  });
});
