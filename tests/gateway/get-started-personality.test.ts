import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { DEFAULT_GET_STARTED_BOT, GET_STARTED_SOUL_START } from "../../packages/contracts/src/index.js";
import { createGetStartedRoutes } from "../../packages/gateway/src/routes/get-started.js";
import { GET_STARTED_MATRIX_BOT_REQUEST_ID, createGetStartedMatrixBot } from "../../packages/gateway/src/get-started/matrix-bot.js";
import { setProfileFields } from "../../packages/gateway/src/get-started/personality.js";

const TEMPLATE_SOUL = "# Soul\n\nBe genuinely helpful.\n";
const IDENTITY = "# Identity\n\n- **Name:** Matrix OS\n- **Vibe:** Direct, curious, proactive\n- **Emoji:**\n";
const USER = "# User\n\n- **Name:**\n- **What to call them:**\n- **Timezone:**\n";
const ATLAS = { ...DEFAULT_GET_STARTED_BOT, name: "Atlas", personality: "straight-shooter" as const, length: "short" as const };

describe("get started personality", () => {
  let homePath: string;
  let ensureMatrixBot: ReturnType<typeof vi.fn>;
  let app: Hono;

  function mount(options: { owner?: string | null } = {}) {
    app = new Hono();
    app.route("/api/settings/get-started", createGetStartedRoutes({
      homePath,
      enabled: true,
      getOwnerId: () => (options.owner === undefined ? "user_owner" : options.owner),
      ensureMatrixBot,
    }));
  }

  function complete(bot: unknown | null = ATLAS) {
    return app.request("/api/settings/get-started", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "complete", answers: { name: "Sam", goals: ["code"], tools: [], ...(bot === null ? {} : { bot }) } }),
    });
  }

  const read = (file: string) => readFile(join(homePath, "system", file), "utf-8");

  beforeEach(async () => {
    homePath = resolve(await mkdtemp(join(tmpdir(), "get-started-personality-")));
    await mkdir(join(homePath, "system"));
    await writeFile(join(homePath, "system", "get-started.json"), '{"version":1,"status":"in_progress","updatedAt":"2026-10-25T10:00:00.000Z","draft":{"step":3}}');
    await writeFile(join(homePath, "system", "soul.md"), TEMPLATE_SOUL);
    await writeFile(join(homePath, "system", "identity.md"), IDENTITY);
    await writeFile(join(homePath, "system", "user.md"), USER);
    ensureMatrixBot = vi.fn(async () => undefined);
    mount();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homePath, { recursive: true, force: true });
  });

  it("puts the managed section first in the one owner SOUL and keeps the template", async () => {
    expect((await complete()).status).toBe(200);
    const soul = await read("soul.md");
    expect(soul.startsWith(GET_STARTED_SOUL_START)).toBe(true);
    expect(soul).toContain("Your name is Atlas. You are Sam's personal Matrix assistant.");
    expect(soul.endsWith("# Soul\n\nBe genuinely helpful.\n")).toBe(true);
  });

  it("fills the identity and user name lines in place", async () => {
    await complete();
    expect(await read("identity.md")).toContain("- **Name:** Atlas\n- **Vibe:** Straight shooter\n- **Emoji:**");
    expect(await read("user.md")).toContain("- **Name:** Sam\n- **What to call them:** Sam\n- **Timezone:**");
  });

  it("creates the owner's Matrix Bot with the chosen name", async () => {
    await complete();
    expect(ensureMatrixBot).toHaveBeenCalledExactlyOnceWith("user_owner", "Atlas");
  });

  it("finishes setup even when the bot cannot be created", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ensureMatrixBot.mockRejectedValueOnce(new Error("db down"));
    const res = await complete();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("completed");
  });

  function retryBots() {
    return app.request("/api/settings/get-started/bots", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }

  it("keeps a retry path when the Matrix Bot cannot be created at the end of setup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ensureMatrixBot.mockRejectedValueOnce(new Error("db down"));
    expect((await complete()).status).toBe(200);
    const res = await retryBots();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bots: { "matrix-bot": "ready" } });
    expect(ensureMatrixBot).toHaveBeenNthCalledWith(2, "user_owner", "Atlas");
  });

  it("reports a retry that fails again, and refuses retries before setup is finished or without the bot service", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await retryBots()).status).toBe(404);
    await complete();
    ensureMatrixBot.mockRejectedValueOnce(new Error("db down"));
    expect(await (await retryBots()).json()).toEqual({ bots: { "matrix-bot": "failed" } });
    mount({ owner: null });
    expect((await retryBots()).status).toBe(401);
    app = new Hono();
    app.route("/api/settings/get-started", createGetStartedRoutes({ homePath, enabled: true, getOwnerId: () => "user_owner" }));
    expect((await retryBots()).status).toBe(503);
  });

  it("retries the saved Matrix Bot when a finished setup is read, at most once per cooldown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let at = Date.parse("2026-10-25T10:00:00.000Z");
    app = new Hono();
    app.route("/api/settings/get-started", createGetStartedRoutes({
      homePath, enabled: true, getOwnerId: () => "user_owner", ensureMatrixBot, now: () => new Date(at),
    }));
    ensureMatrixBot.mockRejectedValueOnce(new Error("db down"));
    await complete();
    at += 11 * 60 * 1000;
    await app.request("/api/settings/get-started");
    await vi.waitFor(() => expect(ensureMatrixBot).toHaveBeenCalledTimes(2));
    await app.request("/api/settings/get-started");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ensureMatrixBot).toHaveBeenCalledTimes(2);
  });

  it("replays safely: one managed section, and the bot request again", async () => {
    await complete();
    await complete();
    const soul = await read("soul.md");
    expect(soul.split(GET_STARTED_SOUL_START)).toHaveLength(2);
    expect(ensureMatrixBot).toHaveBeenCalledTimes(2);
  });

  it("leaves SOUL, profiles and bots alone without bot choices", async () => {
    await complete(null);
    expect(await read("soul.md")).toBe(TEMPLATE_SOUL);
    expect(await read("identity.md")).toBe(IDENTITY);
    expect(ensureMatrixBot).not.toHaveBeenCalled();
  });

  it("does not create a bot without an authenticated owner", async () => {
    mount({ owner: null });
    await complete();
    expect(ensureMatrixBot).not.toHaveBeenCalled();
  });

  it("never reads or writes a profile through a symlink", async () => {
    const outside = join(homePath, "outside-identity.md");
    await writeFile(outside, IDENTITY);
    await rm(join(homePath, "system", "identity.md"));
    await symlink(outside, join(homePath, "system", "identity.md"));
    expect((await complete()).status).toBe(200);
    expect(await readFile(outside, "utf-8")).toBe(IDENTITY);
  });

  it("refuses a symlinked SOUL with a retryable generic error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outside = join(homePath, "outside.md");
    await writeFile(outside, "untouched\n");
    await rm(join(homePath, "system", "soul.md"));
    await symlink(outside, join(homePath, "system", "soul.md"));
    const res = await complete();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unable to save your setup" });
    expect(await readFile(outside, "utf-8")).toBe("untouched\n");
    // Setup stays unfinished so the wizard retries instead of closing without the owner's AI.
    expect(JSON.parse(await read("get-started.json")).status).toBe("in_progress");
    expect(ensureMatrixBot).not.toHaveBeenCalled();
  });
});

describe("setProfileFields", () => {
  it("replaces existing field values only", () => {
    expect(setProfileFields("- **Name:** Old\n- **Other:** x\nName: plain", { Name: "New", Missing: "y" }))
      .toBe("- **Name:** New\n- **Other:** x\nName: plain");
  });
});

describe("createGetStartedMatrixBot", () => {
  it("instantiates the current matrix-bot recipe with a fixed request id", async () => {
    const instantiate = vi.fn(async () => ({}));
    const ensure = createGetStartedMatrixBot({
      recipes: { list: () => [{ recipeId: "matrix-bot", version: "2026-10-10.1" }] as never },
      instantiation: { instantiate } as never,
    });
    await ensure("user_owner", "Atlas");
    expect(instantiate).toHaveBeenCalledWith("user_owner", {
      clientRequestId: GET_STARTED_MATRIX_BOT_REQUEST_ID,
      recipe: { recipeId: "matrix-bot", version: "2026-10-10.1" },
      name: "Atlas",
    });
  });

  it("fails clearly when the recipe is gone", async () => {
    const ensure = createGetStartedMatrixBot({ recipes: { list: () => [] }, instantiation: { instantiate: vi.fn() } as never });
    await expect(ensure("user_owner", "Atlas")).rejects.toThrow("MatrixBotRecipeUnavailable");
  });
});
