import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { TerminalTabSchema } from "@matrix-os/contracts";

/** Agent launchers use absolute paths; Terminal stores owner-home relative paths. */
export async function agentTerminalCwd(homePath: string, launchCwd: string): Promise<string> {
  const [home, cwd] = await Promise.all([realpath(homePath), realpath(launchCwd)]);
  return TerminalTabSchema.shape.cwd.parse(relative(home, cwd));
}
