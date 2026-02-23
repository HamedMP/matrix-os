import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Identity & Profile", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("GET /api/identity returns handle object from template", async () => {
    const res = await fetch(`${gw.url}/api/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("handle");
    expect(body).toHaveProperty("aiHandle");
    expect(body).toHaveProperty("displayName");
    expect(body).toHaveProperty("createdAt");
  });

  it("GET /api/identity reflects template defaults (empty strings)", async () => {
    const res = await fetch(`${gw.url}/api/identity`);
    const body = await res.json();
    expect(body.handle).toBe("");
    expect(body.aiHandle).toBe("");
    expect(body.displayName).toBe("");
    expect(body.createdAt).toBe("");
  });

  it("GET /api/identity reflects custom handle.json", async () => {
    const custom = {
      handle: "@alice:matrix-os.com",
      aiHandle: "@alice_ai:matrix-os.com",
      displayName: "Alice",
      createdAt: "2025-01-01T00:00:00Z",
    };
    writeFileSync(
      join(gw.homePath, "system", "handle.json"),
      JSON.stringify(custom, null, 2),
    );

    const res = await fetch(`${gw.url}/api/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe("@alice:matrix-os.com");
    expect(body.aiHandle).toBe("@alice_ai:matrix-os.com");
    expect(body.displayName).toBe("Alice");
    expect(body.createdAt).toBe("2025-01-01T00:00:00Z");
  });

  it("GET /api/profile returns profile markdown text", async () => {
    const res = await fetch(`${gw.url}/api/profile`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("# Profile");
    expect(text).toContain("Language: en");
  });

  it("GET /api/ai-profile returns AI profile markdown text", async () => {
    const res = await fetch(`${gw.url}/api/ai-profile`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# AI Profile");
    expect(text).toContain("Personality:");
  });

  it("GET /api/profile returns custom content after write", async () => {
    const custom = "# Profile\n\nDisplay Name: Bob\nBio: Builder\nTimezone: UTC\nLanguage: en\n";
    writeFileSync(join(gw.homePath, "system", "profile.md"), custom);

    const res = await fetch(`${gw.url}/api/profile`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Display Name: Bob");
    expect(text).toContain("Bio: Builder");
  });
});
