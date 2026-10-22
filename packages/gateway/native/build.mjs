import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(directory, "../dist/collaboration/filesystem-identity.node");
if (process.platform !== "linux") {
  rmSync(output, { force: true });
  console.log("Filesystem generation identity requires a supported Linux filesystem; other hosts fail closed.");
} else {
  const includes = [process.env.MATRIX_NODE_INCLUDE, resolve(dirname(process.execPath), "../include/node"), "/usr/include/node", "/usr/local/include/node"].filter(Boolean);
  const include = includes.find((path) => existsSync(join(path, "node_api.h")));
  if (!include) throw new Error("Node N-API headers are required to build filesystem identity (MATRIX_NODE_INCLUDE)");
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    execFileSync(process.env.CC || "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=8", `-I${include}`, join(directory, "filesystem-identity.c"), "-o", temporary], { stdio: "inherit", timeout: 30_000 });
    renameSync(temporary, output);
  } finally { rmSync(temporary, { force: true }); }
}
