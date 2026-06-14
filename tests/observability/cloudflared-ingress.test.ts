import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cloudflared observability ingress", () => {
  it("does not expose Grafana through the public tunnel", async () => {
    const source = await readFile("distro/cloudflared.yml", "utf8");

    expect(source).not.toContain("grafana.matrix-os.com");
    expect(source).not.toMatch(/service:\s*http:\/\/grafana:3000/);
  });
});
