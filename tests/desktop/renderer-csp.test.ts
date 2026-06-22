import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function rendererHtml(): string {
  return readFileSync(resolve("desktop/src/renderer/index.html"), "utf8");
}

function staticRendererCsp(): string | null {
  const html = readFileSync(resolve("desktop/src/renderer/index.html"), "utf8");
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  return match?.[1] ?? null;
}

describe("desktop renderer CSP", () => {
  it("keeps runtime gateway connect policy out of static packaged HTML", () => {
    const html = rendererHtml();
    const csp = staticRendererCsp();

    expect(html).toContain("CSP is injected by the Electron main process");
    expect(csp).toBeNull();
    expect(html).not.toContain("connect-src https:");
    expect(html).not.toContain("connect-src *");
  });
});
