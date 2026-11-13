import { renderDevStackTerminalProfile } from "./devstack-profile.js";

const [namespace, account, ...extra] = process.argv.slice(2);
if (namespace === undefined || account === undefined || extra.length > 0) {
  console.error("Usage: node render-devstack-profile.js <namespace> <mds-account>");
  process.exitCode = 1;
} else {
  try {
    process.stdout.write(JSON.stringify(renderDevStackTerminalProfile(namespace, account), null, 2) + "\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "terminal_profile_render_failed");
    process.exitCode = 1;
  }
}
