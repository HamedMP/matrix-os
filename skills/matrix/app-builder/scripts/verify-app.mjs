import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

// Dependency-free preflight for owner-built Vite apps. This is not an installer
// or a trust migration: never rewrite manifests or promote imported apps here.
const appDir = resolve(process.argv[2] ?? ".");
try {
  const m = JSON.parse(await readFile(join(appDir, "matrix.json"), "utf8"));
  const errors = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("matrix.json must contain an object");
  if (typeof m.name !== "string" || !m.name.trim()) errors.push("name is required");
  if (typeof m.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.slug)) errors.push("slug is invalid");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) errors.push("version is required");
  if (m.runtime !== "vite") errors.push("this preflight requires runtime: vite");
  if (typeof m.runtimeVersion !== "string" || !/^[\^~]?\d+\.\d+\.\d+$/.test(m.runtimeVersion)) errors.push("runtimeVersion must be a semver range");
  if (m.listingTrust !== "first_party") errors.push("owner-built apps require listingTrust: first_party; do not relabel imported apps");
  if ((m.scope ?? "personal") !== "personal") errors.push("owner app launch requires scope: personal");
  if (m.build?.output !== "dist" || typeof m.build?.command !== "string" || !m.build.command.trim()) errors.push("build.command and build.output: dist are required");
  if ("distributionStatus" in m) errors.push("distributionStatus is computed by Matrix; remove the authored field");
  if (errors.length) throw new Error(errors.join("\n"));
  if (!(await stat(join(appDir, "dist/index.html"))).isFile()) throw new Error("dist/index.html must be a file");
  console.log(`Manifest and build verified: /apps/${m.slug}/`);
  console.log("Next: open in Matrix; verify launch, assets, bridge, persistence, and visual states. This preflight does not verify a live session.");
} catch (error) {
  console.error("App preflight failed:", error instanceof Error ? error.message : "unable to validate app");
  process.exitCode = 1;
}
