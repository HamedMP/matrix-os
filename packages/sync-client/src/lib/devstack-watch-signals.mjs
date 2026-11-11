// A signal sent to the launcher PID must let the foreground watch restore its lease.
export function forwardDevstackWatchSignals(child, args) {
  const command = args.indexOf("devstack");
  if (command === -1 || !args.slice(command + 1).includes("watch")) return;
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
