import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";

/** For session tests with a stub Terminal and a real executable version probe. */
export async function writeCodexVersionFixture(homePath: string): Promise<string> {
  const executable = join(homePath, "codex-version-fixture");
  await writeFile(executable, `#!/bin/sh
if [ "$#" -ne 1 ] || [ "$1" != "--version" ]; then
  exit 1
fi
printf '%s\\n' 'codex-cli ${CODEX_VERIFIED_VERSION}'
`, { flag: "wx", mode: 0o700 });
  return executable;
}
