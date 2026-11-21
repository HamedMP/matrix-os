import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(directory, "../dist/terminal/terminal-writer.node");
if (process.platform !== "linux") {
  rmSync(output, { force: true });
  console.log("Terminal writer proof requires Linux; ordinary Terminal remains available.");
} else {
  const includes = [process.env.MATRIX_NODE_INCLUDE, resolve(dirname(process.execPath), "../include/node"), "/usr/include/node", "/usr/local/include/node"].filter(Boolean);
  const include = includes.find(path => existsSync(join(path, "node_api.h")));
  if (!include) throw new Error("Node N-API headers required for Terminal writer proof");
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    execFileSync(process.env.CC || "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=8", `-I${include}`, join(directory, "terminal-writer.c"), "-o", temporary], { stdio: "inherit", timeout: 30000 });
    renameSync(temporary, output);
  } finally { rmSync(temporary, { force: true }); }
}
