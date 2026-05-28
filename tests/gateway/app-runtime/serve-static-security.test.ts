import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { serveStaticFileWithin } from "../../../packages/gateway/src/app-runtime/serve-static.js";

function mockContext(): any {
  return {
    req: {
      header: () => undefined,
    },
    text: (body: string, status: number) => new Response(body, { status }),
  };
}

describe("serveStaticFileWithin security headers", () => {
  it("serves app HTML with a CSP that blocks third-party scripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-static-csp-"));
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><script src="https://code.iconify.design/iconify-icon/2.3.0/iconify-icon.min.js"></script>',
      "utf8",
    );

    const res = await serveStaticFileWithin(dir, "index.html", mockContext());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("https://code.iconify.design");
  });
});
