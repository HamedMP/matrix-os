import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const run = promisify(execFile);

it("production Python exchange preserves concurrent tuples and original unknown UUID while native result JSON text stays bounded for success and denials", async () => {
  const result = await run("python3", ["-I", "-S", "-B", resolve("tests/fixtures/hermes-routine-exchange.py"), resolve("packages/gateway/src/chat/hermes-routine-tool.py")],
    { timeout: 10_000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", PYTHONDONTWRITEBYTECODE: "1" } });
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, cases: 7, nativeResultText: true, nativePublicApi: false });
  expect(result.stderr).toBe("");
});

it("gateway build's actual public Python resource staging command preserves executable bytes", async () => {
  const dir = await mkdtemp("/tmp/hr-package-");
  try {
    const pkg = JSON.parse(await readFile("packages/gateway/package.json", "utf8"));
    const command = pkg.scripts.build.split(" && ").find((part: string) => part.startsWith("cp src/chat/"));
    expect(command).toBe("cp src/chat/hermes-routine-tool.py dist/chat/");
    await run("cp", ["src/chat/hermes-routine-tool.py", dir], { cwd: resolve("packages/gateway"), timeout: 5000 });
    expect(await readFile(join(dir, "hermes-routine-tool.py"))).toEqual(await readFile("packages/gateway/src/chat/hermes-routine-tool.py"));
    await run("python3", ["-I", "-S", "-B", "-c", "import ast,sys; ast.parse(open(sys.argv[1], 'rb').read())", join(dir, "hermes-routine-tool.py")], { timeout: 5000 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
