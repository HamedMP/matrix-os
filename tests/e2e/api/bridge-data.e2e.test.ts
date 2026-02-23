import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Bridge data API", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("writes data for an app", async () => {
    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "notes", key: "prefs", value: "dark" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("reads back written data", async () => {
    // Write first
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "notes", key: "prefs", value: "dark" }),
    });

    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", app: "notes", key: "prefs" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe("dark");
  });

  it("returns null for nonexistent key", async () => {
    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", app: "notes", key: "nonexistent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it("overwrites existing data with latest value", async () => {
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "notes", key: "theme", value: "light" }),
    });

    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "notes", key: "theme", value: "dark" }),
    });

    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", app: "notes", key: "theme" }),
    });
    const body = await res.json();
    expect(body).toBe("dark");
  });

  it("persists data as files on disk", async () => {
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "myapp", key: "setting", value: "hello" }),
    });

    const filePath = join(gw.homePath, "data", "myapp", "setting.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content).toBe("hello");
  });

  it("sanitizes special characters in app names", async () => {
    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "../evil", key: "hack", value: "bad" }),
    });
    expect(res.status).toBe(200);

    // The "../evil" app name should be sanitized to "evil" (dots and slashes stripped)
    const sanitizedPath = join(gw.homePath, "data", "evil", "hack.json");
    expect(existsSync(sanitizedPath)).toBe(true);

    // Verify no file was created at the traversal path
    const traversalPath = join(gw.homePath, "evil", "hack.json");
    expect(existsSync(traversalPath)).toBe(false);
  });

  it("sanitizes special characters in key names", async () => {
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "safe", key: "../../etc/passwd", value: "x" }),
    });

    // Key "../../etc/passwd" is sanitized to "etcpasswd"
    const sanitizedPath = join(gw.homePath, "data", "safe", "etcpasswd.json");
    expect(existsSync(sanitizedPath)).toBe(true);
  });
});
