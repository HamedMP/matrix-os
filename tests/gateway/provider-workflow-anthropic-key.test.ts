import { chmod, link, mkdtemp, mkdir, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnerAnthropicKeySaver, readOwnerAnthropicKey, revokeOwnerAnthropicKey } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { buildKernelEnv } from "../../packages/gateway/src/kernel-credentials.js";

it("uses one private key source, preserves unrelated legacy config and prevents revoked legacy resurrection", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-key-"));
  try {
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system/config.json"), JSON.stringify({ theme: "dark", kernel: { anthropicApiKey: "sk-ant-old" } }));
    await createOwnerAnthropicKeySaver({ homePath: home })("sk-ant-new");
    expect(await readOwnerAnthropicKey(home)).toMatchObject({ key: "sk-ant-new", state: "unverified" });
    expect((await buildKernelEnv(home, {})).ANTHROPIC_API_KEY).toBe("sk-ant-new");
    expect(JSON.parse(await readFile(join(home, "system/config.json"), "utf8"))).toEqual({ theme: "dark", kernel: { anthropicApiKey: "sk-ant-old" } });
    expect((await stat(join(home, "system/ai-providers/anthropic-key.json"))).mode & 0o777).toBe(0o600);
    await revokeOwnerAnthropicKey(home);
    expect(await readOwnerAnthropicKey(home)).toMatchObject({ state: "setup_required" });
    await expect(buildKernelEnv(home, {}, "owner_anthropic_key")).rejects.toThrow("Selected AI access is unavailable");
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("refuses symlinked custody directories without overwriting another path", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-key-link-"));
  try {
    await mkdir(join(home, "system")); await mkdir(join(home, "other"));
    await symlink(join(home, "other"), join(home, "system/ai-providers"));
    await expect(createOwnerAnthropicKeySaver({ homePath: home })("sk-ant-new")).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("restores the previous credential and exact bytes when replacement activation fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-key-rollback-"));
  try {
    const saver = createOwnerAnthropicKeySaver({ homePath: home });
    await saver("sk-ant-old");
    const path = join(home, "system/ai-providers/anthropic-key.json");
    const before = await readFile(path);
    await expect(saver.connect("sk-ant-new", async () => { throw new Error("activation failed"); })).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(await readOwnerAnthropicKey(home)).toMatchObject({ key: "sk-ant-old" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("restores absence after first key connection activation fails without hiding the legacy key", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-key-first-fail-"));
  try {
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-legacy" } }));
    await expect(createOwnerAnthropicKeySaver({ homePath: home }).connect("sk-ant-new", async () => { throw new Error("activation failed"); })).rejects.toThrow();
    await expect(stat(join(home, "system/ai-providers/anthropic-key.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readOwnerAnthropicKey(home)).toMatchObject({ key: "sk-ant-legacy" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
it.each(["readable", "hardlinked"])("rejects %s private canonical key custody without falling back to legacy", async kind => {
  const home = await mkdtemp(join(tmpdir(), "provider-key-custody-"));
  try {
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system/config.json"), JSON.stringify({kernel:{anthropicApiKey:"sk-ant-legacy"}}));
    await createOwnerAnthropicKeySaver({homePath:home})("sk-ant-new");
    const path = join(home, "system/ai-providers/anthropic-key.json");
    if (kind === "readable") await chmod(path, 0o644);
    else await link(path, join(home, "key-copy"));
    expect(await readOwnerAnthropicKey(home)).toEqual({state:"invalid"});
    await expect(buildKernelEnv(home, {}, "owner_anthropic_key")).rejects.toThrow("Selected AI access is unavailable");
  } finally {await rm(home, {recursive:true, force:true});}
});
