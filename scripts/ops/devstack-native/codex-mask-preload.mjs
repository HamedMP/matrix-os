// Node runs this inside the fixture mount namespace before the original main
// module on every start, including restarts. Never invoke the binary to test it.
import { access, constants } from "node:fs/promises";
import { CODEX_BINARY } from "./security.mjs";

try {
  await access(CODEX_BINARY, constants.X_OK);
  throw Error("installed_codex_visible");
} catch (error) {
  if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
}
