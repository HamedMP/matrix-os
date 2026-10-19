import { expect, it, vi } from "vitest";
import { verifyJevHermesDependencies } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
it.each(["legacy", "managed"] as const)("%s preflight works without optional Anthropic and ignores venv startup hooks", async layout => {
  const mode = "chat_completions";
  const rootsToClean: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "jev-dependency-startup-")); const marker = join(root, "startup-marker");
  try {
    execFileSync("python3", ["-I", "-m", "venv", "--without-pip", join(root, "venv")]);
    const version = execFileSync(join(root, "venv/bin/python"), ["-I", "-S", "-c", "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))"], { encoding: "utf8" }).trim();
    const site = join(root, "venv/lib", `python${version}`, "site-packages");
    await writeFile(join(site, "openai.py"), "SYNTHETIC = True\n");
    await mkdir(join(site, "openai-2.24.0.dist-info"));
    await writeFile(join(site, "openai-2.24.0.dist-info/METADATA"), "Name: openai\nVersion: 2.24.0\n");
    await writeFile(join(site, "startup.pth"), `import os; open(${JSON.stringify(marker)}, 'w').write('unchecked startup')\n`);
    if (layout === "managed") {
      const key = createHash("sha256").update(await realpath(root)).digest("hex").slice(0, 16);
      const state = join(dirname(await realpath(root)), "installs", key);
      rootsToClean.push(state);
      const generation = join(state, "environments", "test-generation");
      await mkdir(join(state, "environments"), { recursive: true });
      await rename(join(root, "venv"), generation);
      await writeFile(join(state, "facts.json"), JSON.stringify({ packages: { venv: { environment: generation } } }));
    }
    const checkedPython = await verifyJevHermesDependencies(root, mode, new AbortController().signal);
    expect(checkedPython).toBe(layout === "legacy" ? join(root, "venv/bin/python")
      : join(rootsToClean[0]!, "environments/test-generation/bin/python"));
    await expect(verifyJevHermesDependencies(root, "anthropic_messages", new AbortController().signal)).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); await Promise.all(rootsToClean.map(path => rm(path, { recursive: true, force: true }))); }
});
it("native Anthropic requires both its optional SDK and Hermes core OpenAI SDK", async () => {
  const command = vi.fn(async () => "2.24.0\n0.87.0\n");
  await verifyJevHermesDependencies("/fixture/hermes", "anthropic_messages", new AbortController().signal, command);
  expect(command).toHaveBeenCalledWith("/fixture/hermes/venv/bin/python", expect.arrayContaining(["-I", "-S", "-c"]), expect.any(AbortSignal));
  const args = command.mock.calls[0] as unknown as [string, string[], AbortSignal];
  expect(args[1].join(" ")).toContain('import_module("anthropic")');
});
it.each(["", "0.86.0\n", "2.24.0\nextra", "missing"])("denies unavailable/mismatched core dependency %j", async value => {
  await expect(verifyJevHermesDependencies("/fixture/hermes", "codex_responses", new AbortController().signal,
    async () => { if (value === "missing") throw new Error("fixture missing package"); return value; })).rejects.toThrow();
});

it.each(["2.24.0\n", "2.24.0\n0.86.0\n"])("denies missing or unverified native Anthropic SDK %j", async value => {
  await expect(verifyJevHermesDependencies("/fixture/hermes", "anthropic_messages", new AbortController().signal,
    async () => value)).rejects.toThrow("Restricted runtime setup required");
});
it("denies an unsupported transport before invoking Python", async () => {
  const command = vi.fn(async () => "2.24.0\n");
  await expect(verifyJevHermesDependencies("/fixture/hermes", "unsupported" as "codex_responses", new AbortController().signal, command))
    .rejects.toThrow("Restricted runtime setup required");
  expect(command).not.toHaveBeenCalled();
});
