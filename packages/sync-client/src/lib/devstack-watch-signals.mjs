import { parseArgs } from "node:util";

const valueOptions = Object.fromEntries(
  ["profile", "gateway", "platform", "token", "stage", "computer", "worktree"]
    .map(name => [name, { type: "string" }]),
);

// A signal sent to the launcher PID must let the foreground watch restore its lease.
export function forwardDevstackWatchSignals(child, args) {
  const { positionals: [command, action] } = parseArgs({
    args, options: valueOptions, allowPositionals: true, strict: false,
  });
  if (command !== "devstack" || action !== "watch") return;
  let forwarded = false;
  const forward = () => {
    if (forwarded) return;
    forwarded = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.prependOnceListener("exit", () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  });
}
