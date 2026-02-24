import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: File management", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("PUT and GET a text file", async () => {
    const content = "hello world";
    const putRes = await fetch(`${gw.url}/files/test.txt`, {
      method: "PUT",
      body: content,
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);

    const getRes = await fetch(`${gw.url}/files/test.txt`);
    expect(getRes.status).toBe(200);
    const text = await getRes.text();
    expect(text).toBe(content);
  });

  it("GET nonexistent file returns 404", async () => {
    const res = await fetch(`${gw.url}/files/nonexistent.txt`);
    expect(res.status).toBe(404);
  });

  it("PUT creates nested directories", async () => {
    const content = "nested content";
    const putRes = await fetch(`${gw.url}/files/nested/dir/file.txt`, {
      method: "PUT",
      body: content,
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${gw.url}/files/nested/dir/file.txt`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(content);
  });

  it("GET path traversal returns 403 or 404", async () => {
    // fetch() normalizes ../.. in URLs before sending, so the server
    // may see an already-resolved path. We test with %2e%2e to bypass
    // client normalization, and also accept 404 (server sees clean path).
    const res = await fetch(`${gw.url}/files/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
    expect([403, 404]).toContain(res.status);
  });

  it("HEAD existing file returns 200", async () => {
    // Ensure file exists first
    await fetch(`${gw.url}/files/head-test.txt`, {
      method: "PUT",
      body: "exists",
    });

    const res = await fetch(`${gw.url}/files/head-test.txt`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
  });

  it("HEAD nonexistent file returns 404", async () => {
    const res = await fetch(`${gw.url}/files/no-such-file.txt`, {
      method: "HEAD",
    });
    expect(res.status).toBe(404);
  });

  it("GET directory returns 400", async () => {
    const res = await fetch(`${gw.url}/files/system`);
    expect(res.status).toBe(400);
  });

  it("serves JSON with correct content-type", async () => {
    const data = JSON.stringify({ key: "value" });
    await fetch(`${gw.url}/files/test-data.json`, {
      method: "PUT",
      body: data,
    });

    const res = await fetch(`${gw.url}/files/test-data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(data);
  });

  it("serves HTML with correct content-type", async () => {
    const html = "<html><body>test</body></html>";
    await fetch(`${gw.url}/files/page.html`, {
      method: "PUT",
      body: html,
    });

    const res = await fetch(`${gw.url}/files/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(html);
  });

  it("serves markdown with correct content-type", async () => {
    const md = "# Hello\n\nWorld";
    await fetch(`${gw.url}/files/readme.md`, {
      method: "PUT",
      body: md,
    });

    const res = await fetch(`${gw.url}/files/readme.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(md);
  });

  it("PUT path traversal returns 403 or 404", async () => {
    // Same as GET: fetch() normalizes ../.. before sending
    const res = await fetch(`${gw.url}/files/%2e%2e/%2e%2e/outside.txt`, {
      method: "PUT",
      body: "should fail",
    });
    expect([403, 404]).toContain(res.status);
  });

  it("overwrites existing file on PUT", async () => {
    await fetch(`${gw.url}/files/overwrite.txt`, {
      method: "PUT",
      body: "original",
    });

    await fetch(`${gw.url}/files/overwrite.txt`, {
      method: "PUT",
      body: "updated",
    });

    const res = await fetch(`${gw.url}/files/overwrite.txt`);
    expect(await res.text()).toBe("updated");
  });
});
