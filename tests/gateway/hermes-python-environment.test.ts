import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveHermesPython } from "../../packages/gateway/src/chat/hermes-python-environment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "hermes-env-")); roots.push(temporary);
  const home = join(temporary, ".hermes"); const source = join(home, "hermes-agent");
  await mkdir(source, { recursive: true });
  const key = createHash("sha256").update(await realpath(source)).digest("hex").slice(0, 16);
  const state = join(home, "installs", key); const generation = join(state, "environments", "generation-1");
  await mkdir(join(generation, "bin"), { recursive: true });
  await writeFile(join(generation, "pyvenv.cfg"), "version = 3.14.0\n");
  await writeFile(join(generation, "bin/python"), "fixture", { mode: 0o755 });
  const record = (value: unknown) => writeFile(join(state, "facts.json"), JSON.stringify(value));
  return { home, source, state, generation, record };
}
it("preserves the legacy interpreter before PM commits an environment", async () => {
  const f = await fixture(); expect(await resolveHermesPython(f.source)).toBe(join(f.source, "venv/bin/python"));
});
it("selects the committed generation instead of a stale in-tree venv", async () => {
  const f = await fixture(); await f.record({ packages: { venv: { environment: f.generation } } });
  expect(await resolveHermesPython(f.source)).toBe(join(await realpath(f.generation), "bin/python"));
});
it("uses the canonical checkout path for upstream's install key", async () => {
  const f = await fixture(); const alias = join(f.home, "alias"); await symlink(f.source, alias);
  await f.record({ packages: { venv: { environment: f.generation } } });
  expect(await resolveHermesPython(alias)).toBe(join(await realpath(f.generation), "bin/python"));
});
it.each([null, {}, { packages: { venv: { environment: 42 } } }, { packages: { venv: { environment: "/tmp/outside" } } }])("rejects invalid committed state %j", async value => {
  const f = await fixture(); await f.record(value);
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});
it("rejects a vanished committed generation without falling back", async () => {
  const f = await fixture(); await f.record({ packages: { venv: { environment: join(f.state, "environments/missing") } } });
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});
it("rejects a generation symlink escaping its installation", async () => {
  const f = await fixture(); const escape = join(f.state, "environments/escape"); await symlink(tmpdir(), escape);
  await f.record({ packages: { venv: { environment: escape } } });
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});

it.each(["environments", "install-state"])("rejects an escaped %s root", async kind => {
  const f = await fixture();
  await f.record({ packages: { venv: { environment: f.generation } } });
  const target = kind === "environments" ? join(f.state, "environments") : f.state;
  const outside = join(f.home, "outside");
  await rename(target, outside);
  await symlink(outside, target);
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});

it("rejects symlinked selection records instead of reading a different file", async () => {
  const f = await fixture(); const outside = join(f.home, "outside.json");
  await writeFile(outside, JSON.stringify({ packages: { venv: { environment: f.generation } } }));
  await symlink(outside, join(f.state, "facts.json"));
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});

it.each(["{", " ".repeat(1024 * 1024 + 1)])("rejects invalid or oversized selection records (%#)", async value => {
  const f = await fixture(); await writeFile(join(f.state, "facts.json"), value);
  await expect(resolveHermesPython(f.source)).rejects.toThrow("Hermes runtime setup required");
});

it("rejects a FIFO selection record without waiting for an owner writer", async () => {
  const f = await fixture(); const fifo = join(f.state, "facts.json");
  execFileSync("mkfifo", [fifo]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = resolveHermesPython(f.source).then(() => "accepted", error => error.message);
  let observed: string;
  try {
    observed = await Promise.race([pending, new Promise<string>(resolve => { timer = setTimeout(() => resolve("blocked on FIFO"), 1000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    // Unblock the old implementation too, so a RED run leaves no pending I/O.
    const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try { await pending; } finally { await writer.close(); }
  }
  expect(observed).toBe("Hermes runtime setup required");
});

it("preserves a legitimate venv interpreter symlink into the PM Python store", async () => {
  const f = await fixture(); const binary = join(f.home, "store-python");
  await writeFile(binary, "fixture", { mode: 0o755 });
  await rm(join(f.generation, "bin/python"));
  await symlink(binary, join(f.generation, "bin/python"));
  await f.record({ packages: { venv: { environment: f.generation } } });
  expect(await resolveHermesPython(f.source)).toBe(join(await realpath(f.generation), "bin/python"));
});
