import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createOwnerOpenRouterKeySaver,
  readOwnerOpenRouterKey,
  revokeOwnerOpenRouterKey,
} from "../../packages/gateway/src/ai-providers/owner-openrouter-key.js";

it("stores one private OpenRouter key and advances generation on rotation and revoke", async () => {
  const home = await mkdtemp(join(tmpdir(), "openrouter-key-"));
  try {
    const saver = createOwnerOpenRouterKeySaver({ homePath: home });
    await saver("sk-or-v1");
    const first = await readOwnerOpenRouterKey(home);
    expect(first).toMatchObject({ state: "unverified", key: "sk-or-v1" });
    expect(first.credentialGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect((await stat(join(home, "system/ai-providers/openrouter-key.json"))).mode & 0o777).toBe(0o600);

    let committed: string | undefined;
    await saver.connect("sk-or-v2", async generation => { committed = generation; });
    expect((await readOwnerOpenRouterKey(home))).toMatchObject({ key: "sk-or-v2", credentialGeneration: committed });
    expect(committed).not.toBe(first.credentialGeneration);

    await revokeOwnerOpenRouterKey(home);
    const revoked = await readOwnerOpenRouterKey(home);
    expect(revoked).toMatchObject({ state: "setup_required" });
    expect(revoked.credentialGeneration).not.toBe(committed);
    expect(revoked.key).toBeUndefined();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("rolls back exact OpenRouter credential bytes when account activation fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "openrouter-key-rollback-"));
  try {
    const saver = createOwnerOpenRouterKeySaver({ homePath: home });
    await saver("sk-or-old");
    const path = join(home, "system/ai-providers/openrouter-key.json");
    const before = await readFile(path);
    await expect(saver.connect("sk-or-new", async () => { throw new Error("activation failed"); })).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(await readOwnerOpenRouterKey(home)).toMatchObject({ key: "sk-or-old" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("drains supervised runs before publishing a rotation and releases the execution fence", async () => {
  const home = await mkdtemp(join(tmpdir(), "openrouter-key-drain-"));
  try {
    const events: string[] = [];
    const release = vi.fn(async () => { events.push("release"); });
    const saver = createOwnerOpenRouterKeySaver({
      homePath: home,
      prepareCredentialChange: async () => {
        events.push("prepare");
        return release;
      },
    });
    await saver.connect("sk-or-new", async () => { events.push("commit"); });
    expect(events).toEqual(["prepare", "commit", "release"]);
    expect(release).toHaveBeenCalledOnce();

    const before = await readFile(join(home, "system/ai-providers/openrouter-key.json"));
    const blocked = createOwnerOpenRouterKeySaver({
      homePath: home,
      prepareCredentialChange: async () => { throw new Error("child stop unconfirmed"); },
    });
    await expect(blocked("sk-or-must-not-publish")).rejects.toThrow();
    expect(await readFile(join(home, "system/ai-providers/openrouter-key.json"))).toEqual(before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("rejects symlinked, readable, and hardlinked OpenRouter custody", async () => {
  const linkedHome = await mkdtemp(join(tmpdir(), "openrouter-link-"));
  try {
    await mkdir(join(linkedHome, "system")); await mkdir(join(linkedHome, "other"));
    await symlink(join(linkedHome, "other"), join(linkedHome, "system/ai-providers"));
    await expect(createOwnerOpenRouterKeySaver({ homePath: linkedHome })("sk-or-new")).rejects.toThrow();
  } finally { await rm(linkedHome, { recursive: true, force: true }); }

  const parentHome = await mkdtemp(join(tmpdir(), "openrouter-parent-link-"));
  try {
    await mkdir(join(parentHome, "outside"));
    await symlink(join(parentHome, "outside"), join(parentHome, "system"));
    await expect(createOwnerOpenRouterKeySaver({ homePath: parentHome })("sk-or-new")).rejects.toThrow();
    await expect(stat(join(parentHome, "outside/ai-providers"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(parentHome, { recursive: true, force: true }); }

  for (const kind of ["readable", "hardlinked"] as const) {
    const home = await mkdtemp(join(tmpdir(), "openrouter-custody-"));
    try {
      await createOwnerOpenRouterKeySaver({ homePath: home })("sk-or-new");
      const path = join(home, "system/ai-providers/openrouter-key.json");
      if (kind === "readable") await chmod(path, 0o644);
      else await link(path, join(home, "key-copy"));
      expect(await readOwnerOpenRouterKey(home)).toEqual({ state: "invalid" });
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

