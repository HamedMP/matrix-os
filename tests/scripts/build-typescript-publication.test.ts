import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps a fresh real consumer on the complete old revision when publication faults after compilation", async () => {
  const pkg = await mkdtemp(join(tmpdir(), "matrix-exchange-"));
  const wrapper = new URL("../../scripts/build-typescript.mjs", import.meta.url).href;
  try {
    await mkdir(join(pkg, "dist"));
    await writeFile(join(pkg, "dist/a.cjs"), 'module.exports = "old";');
    await writeFile(join(pkg, "dist/b.cjs"), 'module.exports = "old";');
    const consumer = () => spawnSync(process.execPath, ["-e", 'console.log(require("./dist/a.cjs") + ":" + require("./dist/b.cjs"))'],
      { cwd: pkg, encoding: "utf8", timeout: 5000 });
    const python = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding:"utf8" });
    expect(python.status, python.stderr).toBe(0);
    const bin = join(pkg, "bin");
    await mkdir(bin);
    // Remove the prepared *private* candidate just before the real libc call.
    // Both replacement files must already be present; a pre-compile failure or
    // a permissions-only precheck cannot satisfy this condition.
    const helper = join(bin, "python3");
    await writeFile(helper, '#!/bin/sh\nset -eu\ntest -f "$5/a.cjs" && test -f "$5/b.cjs"\necho ready > prepared\n/bin/mv "$5" "$5.gone"\nexec "$REAL_PYTHON" "$@"\n');
    await chmod(helper, 0o755);
    const source = `import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
      const original = fs.rename;
      fs.rename = async (from, to) => {
        if (to.endsWith("/dist/b.cjs")) throw new Error("fixture publication fault");
        return original(from, to);
      };
      syncBuiltinESMExports();
      const {buildTypescript} = await import(${JSON.stringify(wrapper)});
      // Both old renames and the new single exchange are faulted at their commit boundary.
      const status = await buildTypescript(process.cwd(), async args => {
        const stage = args[args.indexOf("--outDir") + 1];
        for (const name of ["a", "b"]) await fs.writeFile(stage+"/"+name+".cjs", 'module.exports = "new";');
        await fs.writeFile("compiled", "yes");
        process.env.PATH = ${JSON.stringify(bin)};
        return 0;
      });
      process.exitCode = status;`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pkg, env: { ...process.env, REAL_PYTHON: python.stdout.trim() }, encoding:"utf8", timeout:10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(await readFile(join(pkg, "compiled"), "utf8")).toBe("yes");
    const after = consumer();
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout.trim()).toBe("old:old");
    expect(await readFile(join(pkg, "prepared"), "utf8")).toBe("ready\n");
    expect(result.stderr).toContain("No such file or directory");
  } finally { await rm(pkg, { recursive:true, force:true }); }
});
