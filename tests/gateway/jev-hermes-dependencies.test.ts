import { expect, it, vi } from "vitest";
import { verifyJevHermesDependencies } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
it.each(["codex_responses", "chat_completions"] as const)("%s preflight works without optional Anthropic and ignores venv startup hooks", async mode => {
  const root = await mkdtemp(join(tmpdir(), "jev-dependency-startup-")); const marker = join(root, "startup-marker");
  try {
    execFileSync("python3", ["-I", "-m", "venv", "--without-pip", join(root, "venv")]);
    const version = execFileSync(join(root, "venv/bin/python"), ["-I", "-S", "-c", "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))"], { encoding: "utf8" }).trim();
    const site = join(root, "venv/lib", `python${version}`, "site-packages");
    await writeFile(join(site, "openai.py"), "SYNTHETIC = True\n");
    await mkdir(join(site, "openai-2.24.0.dist-info"));
    await writeFile(join(site, "openai-2.24.0.dist-info/METADATA"), "Name: openai\nVersion: 2.24.0\n");
    await writeFile(join(site, "startup.pth"), `import os; open(${JSON.stringify(marker)}, 'w').write('unchecked startup')\n`);
    await verifyJevHermesDependencies(root, mode, new AbortController().signal);
    await expect(verifyJevHermesDependencies(root, "anthropic_messages", new AbortController().signal)).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
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
