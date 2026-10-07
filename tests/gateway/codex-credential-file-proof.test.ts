import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCodexCredentialFileProofReader } from "../../packages/gateway/src/ai-providers/codex-credential-file-proof.js";

const roots: string[] = [];
const auth = (credential = "private-fixture-token") => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: credential, refresh_token: "private-fixture-refresh" } });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "codex-proof-")); roots.push(home);
  const profile = join(home, ".codex"); await mkdir(profile, { mode: 0o700 });
  const file = join(profile, "auth.json"); await writeFile(file, auth(), { mode: 0o600 });
  return { home, profile, file, read: createCodexCredentialFileProofReader({ homePath: home }) };
}
it("privately binds the selected credential bytes and observes atomic replacement", async () => {
  const f = await fixture(); const before = await f.read();
  expect(before).toMatch(/^[a-f0-9]{64}$/); expect(await f.read()).toBe(before);
  expect(before).not.toContain("private-fixture");
  const replacement = `${f.file}.new`; await writeFile(replacement, auth("changed-token"), { mode: 0o600 }); await rename(replacement, f.file);
  expect(await f.read()).not.toBe(before);
});
it("uses explicit CODEX_HOME instead of borrowing the default profile", async () => {
  const f = await fixture(); const selected = join(f.home, "selected"); await mkdir(selected, { mode: 0o700 });
  await writeFile(join(selected, "auth.json"), auth("selected-token"), { mode: 0o600 });
  const read = createCodexCredentialFileProofReader({ homePath: f.home, codexHome: selected });
  const proof = await read(); expect(proof).not.toBeNull();
  await writeFile(f.file, auth("unrelated-token")); expect(await read()).toBe(proof);
  await writeFile(join(selected, "auth.json"), auth("selected-changed")); expect(await read()).not.toBe(proof);
});
it.each(["file", "profile"])("rejects symlinked %s without following credentials", async target => {
  const f = await fixture(); const original = target === "file" ? f.file : f.profile;
  const moved = `${original}.original`; await rename(original, moved); await symlink(moved, original);
  expect(await f.read()).toBeNull();
});
it.each(["profile", "file"])("rejects replaceable or disclosed %s permissions", async target => {
  const f = await fixture(); await chmod(target === "profile" ? f.profile : f.file, target === "profile" ? 0o777 : 0o644);
  expect(await f.read()).toBeNull();
});
it.each(["missing", "malformed", "oversize", "api-key", "no-credential"])("fails closed for %s", async state => {
  const f = await fixture();
  if (state === "missing") await rm(f.file);
  else await writeFile(f.file, state === "malformed" ? "not-json" : state === "oversize" ? "x".repeat(256 * 1024 + 1) : state === "api-key" ? JSON.stringify({ OPENAI_API_KEY: "private-api-key" }) : "{}");
  expect(await f.read()).toBeNull();
});
