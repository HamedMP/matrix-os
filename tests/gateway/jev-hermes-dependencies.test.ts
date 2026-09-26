import { expect, it, vi } from "vitest";
import { verifyJevHermesDependencies } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("dependency preflight imports the installed SDK without executing ignored venv startup hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-dependency-startup-")); const marker = join(root, "startup-marker");
  try {
    execFileSync("python3", ["-I", "-m", "venv", "--without-pip", join(root, "venv")]);
    const version = execFileSync(join(root, "venv/bin/python"), ["-I", "-S", "-c", "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))"], { encoding: "utf8" }).trim();
    const site = join(root, "venv/lib", `python${version}`, "site-packages");
    await writeFile(join(site, "anthropic.py"), "SYNTHETIC = True\n");
    await mkdir(join(site, "anthropic-0.87.0.dist-info"));
    await writeFile(join(site, "anthropic-0.87.0.dist-info/METADATA"), "Name: anthropic\nVersion: 0.87.0\n");
    await writeFile(join(site, "startup.pth"), `import os; open(${JSON.stringify(marker)}, 'w').write('unchecked startup')\n`);
    await verifyJevHermesDependencies(root, new AbortController().signal);
    await expect(access(marker)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("requires the exact spike-tested Anthropic SDK to import in isolated Python before launch", async () => {
  const command = vi.fn(async (_executable: string, _args: string[], _signal: AbortSignal) => "0.87.0\n");
  await verifyJevHermesDependencies("/fixture/hermes", new AbortController().signal, command);
  expect(command).toHaveBeenCalledWith("/fixture/hermes/venv/bin/python", expect.arrayContaining(["-I", "-c"]), expect.any(AbortSignal));
  expect(command.mock.calls[0]![1].join(" ")).toContain("import anthropic");
});
it.each(["", "0.86.0\n", "0.87.0\nextra", "missing"])("denies unavailable/mismatched dependency %j", async (value) => {
  await expect(verifyJevHermesDependencies("/fixture/hermes", new AbortController().signal,
    async () => { if (value === "missing") throw new Error("fixture missing package"); return value; })).rejects.toThrow();
});
