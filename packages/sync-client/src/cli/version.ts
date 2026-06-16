import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveCliVersion(): string {
  if (process.env.MATRIX_CLI_VERSION) {
    return process.env.MATRIX_CLI_VERSION;
  }

  try {
    const pkg = require("../../package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch (err) {
    void err;
    return "0.0.0";
  }
}
