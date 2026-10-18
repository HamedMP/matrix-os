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
it("reconstructs the same nonsecret generation after reader recreation", async () => {
  const f = await fixture();
  const original = await f.read();
  expect(original).not.toBeNull();
  expect(await createCodexCredentialFileProofReader({ homePath: f.home })()).toBe(original);
  const other = await fixture();
  expect(await other.read()).not.toBe(original);
});

// Official AuthDotJson: API-key credentials may omit auth_mode/tokens or use
// auth_mode=apikey with tokens=null. The digest stays server-private.
it.each([false, true])("binds a file-backed API key (explicit mode=%s) and detects replacement", async explicit => {
  const f = await fixture();
  const key = (value: string) => JSON.stringify({ ...(explicit ? { auth_mode: "apikey", tokens: null } : {}), OPENAI_API_KEY: value });
  await writeFile(f.file, key("synthetic-key-first"));
  expect(await f.read()).toBeNull(); // Subscription consumers retain their default denial.
  const read = createCodexCredentialFileProofReader({ homePath: f.home, allowApiKey: true });
  const before = await read();
  expect(typeof before).toBe("string");
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  expect(await read()).toBe(before);
  expect(before).not.toContain("synthetic-key");
  const replacement = `${f.file}.new`;
  await writeFile(replacement, key("synthetic-key-replacement"), { mode: 0o600 });
  await rename(replacement, f.file);
  const after = await read();
  expect(after).toMatch(/^[a-f0-9]{64}$/);
  expect(after).not.toBe(before);
});
it.each([
  { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "        " }, { OPENAI_API_KEY: 42 },
  { auth_mode: "chatgpt", OPENAI_API_KEY: "synthetic-key" },
  { auth_mode: "unknown", OPENAI_API_KEY: "synthetic-key" },
  { auth_mode: "apikey", OPENAI_API_KEY: "synthetic-key", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } },
])("rejects invalid or conflicting API-key credentials %#", async value => {
  const f = await fixture(); await writeFile(f.file, JSON.stringify(value));
  const read = createCodexCredentialFileProofReader({ homePath: f.home, allowApiKey: true });
  expect(await read()).toBeNull();
});
