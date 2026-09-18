import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexOwnerIdentityResolver } from "../../packages/gateway/src/collaboration/codex-owner-identity.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function homeWithAuth(value: unknown): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-owner-identity-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, ".codex"), { recursive: true });
  await writeFile(join(path, ".codex", "auth.json"), JSON.stringify(value), { mode: 0o600 });
  return path;
}

function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

function accountJwt(exp: number, accountId: string): string {
  return `header.${Buffer.from(JSON.stringify({
    exp,
    chatgpt_account_id: accountId,
  })).toString("base64url")}.signature`;
}

describe("Codex owner provider identity", () => {
  it("resolves API-key auth on the trusted host without returning it to the scope", async () => {
    const homePath = await homeWithAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-owner" });
    const resolve = createCodexOwnerIdentityResolver({ homePath });

    await expect(resolve(new AbortController().signal)).resolves.toEqual({
      url: "https://api.openai.com/v1/responses",
      headers: { authorization: "Bearer sk-owner" },
    });
  });

  it("resolves an unexpired ChatGPT identity with its exact account authority", async () => {
    const homePath = await homeWithAuth({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(Math.floor(Date.now() / 1000) + 3_600),
        refresh_token: "refresh-owner",
        account_id: "acct_owner",
      },
      last_refresh: new Date().toISOString(),
    });
    const fetchImpl = vi.fn();
    const resolve = createCodexOwnerIdentityResolver({ homePath, fetchImpl });

    await expect(resolve(new AbortController().signal)).resolves.toMatchObject({
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {
        authorization: expect.stringMatching(/^Bearer /),
        "chatgpt-account-id": "acct_owner",
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("derives the ChatGPT workspace from the owner id token when the cache omits account_id", async () => {
    const homePath = await homeWithAuth({
      auth_mode: "chatgpt",
      tokens: {
        id_token: accountJwt(Math.floor(Date.now() / 1000) + 3_600, "acct_from_claim"),
        access_token: jwt(Math.floor(Date.now() / 1000) + 3_600),
        refresh_token: "refresh-owner",
      },
      last_refresh: new Date().toISOString(),
    });
    const resolve = createCodexOwnerIdentityResolver({ homePath });

    await expect(resolve(new AbortController().signal)).resolves.toMatchObject({
      headers: { "chatgpt-account-id": "acct_from_claim" },
    });
  });

  it("coalesces proactive refresh and atomically persists rotated owner tokens", async () => {
    const now = Date.UTC(2026, 8, 18, 12, 0, 0);
    const homePath = await homeWithAuth({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(Math.floor(now / 1000) + 60),
        refresh_token: "refresh-owner-old",
        account_id: "acct_owner",
      },
      last_refresh: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await gate;
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "refresh-owner-old",
      });
      return new Response(JSON.stringify({
        access_token: jwt(Math.floor(now / 1000) + 3_600),
        refresh_token: "refresh-owner-new",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const resolve = createCodexOwnerIdentityResolver({ homePath, fetchImpl, now: () => now });

    const first = resolve(new AbortController().signal);
    const second = resolve(new AbortController().signal);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ headers: expect.objectContaining({ "chatgpt-account-id": "acct_owner" }) }),
      expect.objectContaining({ headers: expect.objectContaining({ "chatgpt-account-id": "acct_owner" }) }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const authPath = join(homePath, ".codex", "auth.json");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
      tokens: { refresh_token: "refresh-owner-new" },
      last_refresh: new Date(now).toISOString(),
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("can force one refresh after an upstream unauthorized response", async () => {
    const now = Date.UTC(2026, 8, 18, 12, 0, 0);
    const homePath = await homeWithAuth({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(Math.floor(now / 1000) + 3_600),
        refresh_token: "refresh-owner",
        account_id: "acct_owner",
      },
      last_refresh: new Date(now).toISOString(),
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: jwt(Math.floor(now / 1000) + 7_200),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const resolve = createCodexOwnerIdentityResolver({ homePath, fetchImpl, now: () => now });

    await expect(resolve(new AbortController().signal, true)).resolves.toMatchObject({
      headers: { authorization: expect.stringMatching(/^Bearer /), "chatgpt-account-id": "acct_owner" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns one generic error when owner refresh fails", async () => {
    const now = Date.UTC(2026, 8, 18, 12, 0, 0);
    const homePath = await homeWithAuth({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(Math.floor(now / 1000) + 60),
        refresh_token: "do-not-expose-refresh-token",
        account_id: "acct_owner",
      },
      last_refresh: new Date(now).toISOString(),
    });
    const resolve = createCodexOwnerIdentityResolver({
      homePath,
      now: () => now,
      fetchImpl: async () => new Response("provider-private-error", { status: 401 }),
    });

    const error = await resolve(new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toEqual(expect.objectContaining({ message: "Codex owner identity unavailable" }));
    expect(String(error)).not.toMatch(/refresh-token|provider-private/);
  });

  it("fails closed for a symlinked credential file", async () => {
    const path = await mkdtemp(join(tmpdir(), "codex-owner-identity-unsafe-"));
    cleanup.push(() => rm(path, { recursive: true, force: true }));
    await mkdir(join(path, ".codex"), { recursive: true });
    await writeFile(join(path, "target.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "secret" }));
    await symlink(join(path, "target.json"), join(path, ".codex", "auth.json"));
    const resolve = createCodexOwnerIdentityResolver({ homePath: path });

    await expect(resolve(new AbortController().signal)).rejects.toThrow("Codex owner identity unavailable");
  });

  it.each([
    ["malformed", "{"],
    ["unsupported", JSON.stringify({ auth_mode: "unsupported", OPENAI_API_KEY: "secret" })],
    ["oversized", "x".repeat(1024 * 1024 + 1)],
  ])("fails closed for %s credential storage", async (_case, contents) => {
    const path = await mkdtemp(join(tmpdir(), "codex-owner-identity-unsafe-"));
    cleanup.push(() => rm(path, { recursive: true, force: true }));
    await mkdir(join(path, ".codex"), { recursive: true });
    await writeFile(join(path, ".codex", "auth.json"), contents, { mode: 0o600 });

    const resolve = createCodexOwnerIdentityResolver({ homePath: path });
    await expect(resolve(new AbortController().signal)).rejects.toThrow("Codex owner identity unavailable");
  });
});
