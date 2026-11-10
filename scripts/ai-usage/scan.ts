/** Read-only metrics export; no transcript text or network. */
import { homedir } from "node:os";
export { scanUsageRoots } from "../../packages/contracts/src/ai-usage/node";
import {
  scanUsageRoots,
  usageRoots,
} from "../../packages/contracts/src/ai-usage/node";
if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2);
  const home = homedir();
  const result = await scanUsageRoots(roots.length ? roots : usageRoots(home));
  process.stdout.write(JSON.stringify(result));
  console.error(
    `Usage scan: ${result.events.length} updates; ${result.issues} incomplete/unsupported records. Scope: selected roots only.`,
  );
}
