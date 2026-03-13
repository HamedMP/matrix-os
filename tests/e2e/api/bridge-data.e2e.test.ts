import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("reads back written data wrapped in {value}", async () => {
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
    expect(body).toEqual({ value: "dark" });
  });

  it("returns {value: null} for nonexistent key", async () => {
    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", app: "notes", key: "nonexistent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ value: null });
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
    expect(body).toEqual({ value: "dark" });
  });

  it("stores data as raw value on disk (no double-encoding)", async () => {
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "myapp", key: "setting", value: "hello" }),
    });

    const filePath = join(gw.homePath, "data", "myapp", "setting.json");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("hello");
  });

  it("sanitizes special characters in app names", async () => {
    const res = await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "../evil", key: "hack", value: "bad" }),
    });
    expect(res.status).toBe(200);

    const sanitizedPath = join(gw.homePath, "data", "evil", "hack.json");
    expect(existsSync(sanitizedPath)).toBe(true);

    const traversalPath = join(gw.homePath, "evil", "hack.json");
    expect(existsSync(traversalPath)).toBe(false);
  });

  it("sanitizes special characters in key names", async () => {
    await fetch(`${gw.url}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", app: "safe", key: "../../etc/passwd", value: "x" }),
    });

    const sanitizedPath = join(gw.homePath, "data", "safe", "etcpasswd.json");
    expect(existsSync(sanitizedPath)).toBe(true);
  });

  describe("app-like roundtrip (JSON.stringify array as value)", () => {
    it("writes JSON string and reads it back for JSON.parse", async () => {
      const tasks = [{ id: 1, text: "Clean home", done: false }];
      const jsonValue = JSON.stringify(tasks);

      await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", app: "todo", key: "tasks", value: jsonValue }),
      });

      const res = await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", app: "todo", key: "tasks" }),
      });
      const body = await res.json();
      expect(body.value).toBeDefined();
      const parsed = JSON.parse(body.value);
      expect(parsed).toEqual(tasks);
    });
  });

  describe("IPC tool interop", () => {
    it("bridge reads data written by IPC tool (raw file)", async () => {
      const tasks = [{ id: 1, text: "Buy milk", done: false }];
      const dataDir = join(gw.homePath, "data", "todo");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(tasks), "utf-8");

      const res = await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", app: "todo", key: "tasks" }),
      });
      const body = await res.json();
      expect(body.value).toBeDefined();
      const parsed = JSON.parse(body.value);
      expect(parsed).toEqual(tasks);
    });

    it("IPC tool reads data written by bridge (raw file)", async () => {
      const expenses = [{ amount: 42, desc: "Coffee" }];
      await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          app: "expenses",
          key: "data",
          value: JSON.stringify(expenses),
        }),
      });

      const filePath = join(gw.homePath, "data", "expenses", "data.json");
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(expenses);
    });
  });

  describe("legacy double-encoded file migration", () => {
    it("unwraps double-encoded string on read", async () => {
      const tasks = [{ id: 1, text: "Legacy task" }];
      const doubleEncoded = JSON.stringify(JSON.stringify(tasks));
      const dataDir = join(gw.homePath, "data", "legacy-app");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "items.json"), doubleEncoded, "utf-8");

      const res = await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", app: "legacy-app", key: "items" }),
      });
      const body = await res.json();
      expect(body.value).toBeDefined();
      const parsed = JSON.parse(body.value);
      expect(parsed).toEqual(tasks);
    });

    it("returns non-JSON file content as-is", async () => {
      const rawContent = "function hello() { return 1; }";
      const dataDir = join(gw.homePath, "data", "code-editor");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "file-main-js.json"), rawContent, "utf-8");

      const res = await fetch(`${gw.url}/api/bridge/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", app: "code-editor", key: "file-main-js" }),
      });
      const body = await res.json();
      expect(body.value).toBe(rawContent);
    });
  });
});
