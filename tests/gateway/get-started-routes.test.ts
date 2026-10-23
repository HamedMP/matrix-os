import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createGetStartedRoutes } from "../../packages/gateway/src/routes/get-started.js";

const NOW = new Date("2026-10-25T10:12:00.000Z");

describe("/api/settings/get-started", () => {
  let homePath: string;
  let statePath: string;
  let markerPath: string;
  let app: Hono;

  function mount(enabled = true) {
    app = new Hono();
    app.route("/api/settings/get-started", createGetStartedRoutes({ homePath, enabled, now: () => NOW }));
  }

  async function seed(state: unknown) {
    await writeFile(statePath, JSON.stringify(state));
  }

  async function readState() {
    return JSON.parse(await readFile(statePath, "utf-8"));
  }

  function get() {
    return app.request("/api/settings/get-started");
  }

  function put(body: unknown) {
    return app.request("/api/settings/get-started", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    homePath = resolve(await mkdtemp(join(tmpdir(), "get-started-")));
    await mkdir(join(homePath, "system"), { recursive: true });
    statePath = join(homePath, "system", "get-started.json");
    markerPath = join(homePath, "system", "onboarding-complete.json");
    mount();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chmod(join(homePath, "system"), 0o755).catch(() => undefined);
    await rm(homePath, { recursive: true, force: true });
  });

  describe("GET", () => {
    it("reports not eligible when the home has no marker", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "not_eligible" });
    });

    it("reports not eligible when the feature is disabled, even with a marker", async () => {
      await seed({ version: 1, status: "pending" });
      mount(false);
      expect(await (await get()).json()).toEqual({ status: "not_eligible" });
    });

    it("returns the saved draft for resume", async () => {
      await seed({ version: 1, status: "in_progress", updatedAt: NOW.toISOString(), draft: { step: 2, goals: ["code"] } });
      const body = await (await get()).json();
      expect(body).toEqual({
        status: "in_progress",
        updatedAt: NOW.toISOString(),
        draft: { step: 2, goals: ["code"], tools: [] },
      });
    });

    it("returns a generic 500 for a corrupt state file instead of hiding it as not eligible", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await writeFile(statePath, "{not json");
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unable to load your setup" });
      expect(warn).toHaveBeenCalled();
    });

    it("returns a generic 500 for a state file with an unknown shape", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seed({ version: 1, status: "pending", secret: "x" });
      const res = await get();
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain("secret");
    });
  });

  describe("PUT draft", () => {
    it("moves pending to in_progress and stores the draft", async () => {
      await seed({ version: 1, status: "pending" });
      const res = await put({ type: "draft", draft: { step: 1, name: "Sam" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "in_progress",
        updatedAt: NOW.toISOString(),
        draft: { step: 1, name: "Sam", goals: [], tools: [] },
      });
      expect(await readState()).toMatchObject({ version: 1, status: "in_progress" });
    });

    it("replaces an earlier draft", async () => {
      await seed({ version: 1, status: "in_progress", updatedAt: NOW.toISOString(), draft: { step: 1, name: "Sam" } });
      await put({ type: "draft", draft: { step: 2, name: "Sam", goals: ["build"] } });
      expect((await readState()).draft).toEqual({ step: 2, name: "Sam", goals: ["build"], tools: [] });
    });

    it("rejects drafts after the wizard is finished", async () => {
      await seed({ version: 1, status: "skipped", skippedAt: NOW.toISOString() });
      const res = await put({ type: "draft", draft: { step: 1 } });
      expect(res.status).toBe(409);
      expect((await readState()).status).toBe("skipped");
    });

    it("does not write the onboarding marker", async () => {
      await seed({ version: 1, status: "pending" });
      await put({ type: "draft", draft: { step: 1 } });
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  describe("PUT complete", () => {
    const answers = { name: "Sam", goals: ["code"], tools: ["github", "claude-code"] };

    it("completes from in_progress, stores the answers and writes the onboarding marker", async () => {
      await seed({ version: 1, status: "in_progress", updatedAt: NOW.toISOString(), draft: { step: 3 } });
      const res = await put({ type: "complete", answers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "completed",
        completedAt: NOW.toISOString(),
        answers: { ...answers },
      });
      expect(await readState()).toEqual({ version: 1, status: "completed", completedAt: NOW.toISOString(), answers });
      expect(JSON.parse(await readFile(markerPath, "utf-8"))).toMatchObject({ source: "get-started" });
    });

    it("is idempotent and keeps the first answers", async () => {
      await seed({ version: 1, status: "pending" });
      await put({ type: "complete", answers });
      const res = await put({ type: "complete", answers: { goals: ["build"] } });
      expect(res.status).toBe(200);
      expect((await res.json()).answers.goals).toEqual(["code"]);
    });

    it("keeps an existing onboarding marker untouched", async () => {
      await seed({ version: 1, status: "pending" });
      await writeFile(markerPath, '{"source":"legacy"}\n');
      await put({ type: "complete", answers });
      expect(await readFile(markerPath, "utf-8")).toBe('{"source":"legacy"}\n');
    });

    it("rejects completing a skipped wizard", async () => {
      await seed({ version: 1, status: "skipped", skippedAt: NOW.toISOString() });
      expect((await put({ type: "complete", answers })).status).toBe(409);
    });
  });

  describe("PUT skip", () => {
    it("skips from pending and writes the onboarding marker", async () => {
      await seed({ version: 1, status: "pending" });
      const res = await put({ type: "skip" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", skippedAt: NOW.toISOString() });
      expect(existsSync(markerPath)).toBe(true);
    });

    it("is idempotent", async () => {
      await seed({ version: 1, status: "skipped", skippedAt: "2026-10-24T00:00:00.000Z" });
      const res = await put({ type: "skip" });
      expect(res.status).toBe(200);
      expect((await res.json()).skippedAt).toBe("2026-10-24T00:00:00.000Z");
    });

    it("rejects skipping a completed wizard", async () => {
      await seed({ version: 1, status: "completed", completedAt: NOW.toISOString(), answers: {} });
      expect((await put({ type: "skip" })).status).toBe(409);
    });
  });

  describe("PUT validation and eligibility", () => {
    it("returns 404 without creating state when the home is not eligible", async () => {
      const res = await put({ type: "skip" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Get started is not available" });
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
    });

    it("returns 404 when the feature is disabled", async () => {
      await seed({ version: 1, status: "pending" });
      mount(false);
      expect((await put({ type: "skip" })).status).toBe(404);
      expect((await readState()).status).toBe("pending");
    });

    it.each([
      ["invalid JSON", "{nope"],
      ["unknown type", { type: "reset" }],
      ["unknown goal", { type: "complete", answers: { goals: ["crypto"] } }],
      ["unknown field", { type: "skip", force: true }],
    ])("rejects %s with a generic 400", async (_label, body) => {
      await seed({ version: 1, status: "pending" });
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
      expect((await readState()).status).toBe("pending");
    });

    it("rejects oversized bodies before parsing", async () => {
      await seed({ version: 1, status: "pending" });
      const res = await put({ type: "draft", draft: { step: 1 }, padding: "x".repeat(9 * 1024) });
      expect(res.status).toBe(413);
    });

    it("serialises concurrent terminal updates so only one wins", async () => {
      await seed({ version: 1, status: "pending" });
      const [complete, skip] = await Promise.all([
        put({ type: "complete", answers: { goals: ["code"] } }),
        put({ type: "skip" }),
      ]);
      expect([complete.status, skip.status].sort()).toEqual([200, 409]);
    });
  });

  describe("owner system directory", () => {
    async function linkSystemOutside() {
      const outside = join(homePath, "..", `${homePath.split("/").pop()}-outside`);
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "get-started.json"), JSON.stringify({ version: 1, status: "pending" }));
      await rename(join(homePath, "system"), join(homePath, "system-real"));
      await symlink(outside, join(homePath, "system"));
      return outside;
    }

    it("never reads setup state through a symlinked system directory", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const outside = await linkSystemOutside();
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unable to load your setup" });
      expect(warn).toHaveBeenCalled();
      await rm(outside, { recursive: true, force: true });
    });

    it("never writes setup state or the onboarding marker through a symlinked system directory", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const outside = await linkSystemOutside();
      const res = await put({ type: "skip" });
      expect(res.status).toBe(500);
      expect(JSON.parse(await readFile(join(outside, "get-started.json"), "utf-8"))).toEqual({ version: 1, status: "pending" });
      expect(existsSync(join(outside, "onboarding-complete.json"))).toBe(false);
      await rm(outside, { recursive: true, force: true });
    });
  });

  describe("write failures", () => {
    it("returns a generic 500 and keeps the previous state when the write fails", async () => {
      if (process.getuid?.() === 0) return;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seed({ version: 1, status: "in_progress", updatedAt: NOW.toISOString(), draft: { step: 2, name: "Sam" } });
      await chmod(join(homePath, "system"), 0o555);
      const res = await put({ type: "complete", answers: { name: "Sam", goals: ["code"] } });
      await chmod(join(homePath, "system"), 0o755);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unable to save your setup" });
      expect((await readState()).status).toBe("in_progress");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("Sam");
      expect((await readdir(join(homePath, "system"))).filter((name) => name.includes(".tmp"))).toEqual([]);
    });
  });
});
