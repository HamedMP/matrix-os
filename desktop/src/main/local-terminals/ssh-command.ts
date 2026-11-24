// The ssh commands the Terminal window's core uses for an added machine (spec
// 2706 layer 7), built only here from validated fields. The renderer sends
// fields, never a command. Every value has already matched its own strict
// pattern (no leading `-`, no spaces, quotes or shell signs), and each is
// single-quoted in the core's `via` line anyway.
import type { SshOptions } from "../../shared/local-terminals";
import { sshDestination } from "./hc-machines";

const quote = (value: string) => `'${value}'`;

/** The `via` line herdr-core runs to reach the machine, or null when the plain target does. */
export function sshVia(target: string, options: SshOptions | undefined, tailscaleBinary: string | null): string | null {
  const { destination, port } = sshDestination(target);
  if (options?.tailscaleSsh) {
    if (!tailscaleBinary) throw new Error("tailscale is not installed");
    return `${quote(tailscaleBinary)} ssh ${quote(destination)}`;
  }
  // A port typed into the target (`host:2222`) is herdr-core's own form.
  if (!options?.port && !options?.identity && !options?.jump) return null;
  const chosenPort = options.port ? String(options.port) : port;
  return [
    "ssh", "-o", "BatchMode=yes",
    ...(chosenPort ? ["-p", chosenPort] : []),
    ...(options.identity ? ["-i", quote(options.identity)] : []),
    ...(options.jump ? ["-J", quote(options.jump)] : []),
    "--", quote(destination),
  ].join(" ");
}

/**
 * The `via` line for installing the core there. herdr-core's installer takes a
 * plain target's `host:2222` as the host name (Nima, #3579, pinned 0.1.19), so a
 * port in the target, as well as the advanced port field, goes to ssh as `-p`.
 */
export function installVia(target: string, options: SshOptions | undefined, tailscaleBinary: string | null): string | null {
  const via = sshVia(target, options, tailscaleBinary);
  if (via) return via;
  const { destination, port } = sshDestination(target);
  return port ? ["ssh", "-o", "BatchMode=yes", "-p", port, "--", quote(destination)].join(" ") : null;
}

/** The argv of a terminal running ssh there, where the person answers a host key or password themselves. */
export function sshLoginArgv(target: string, options: SshOptions | undefined, tailscaleBinary: string | null): string[] {
  const { destination, port } = sshDestination(target);
  if (options?.tailscaleSsh) {
    if (!tailscaleBinary) throw new Error("tailscale is not installed");
    return [tailscaleBinary, "ssh", destination];
  }
  const chosenPort = options?.port ? String(options.port) : port;
  return [
    "ssh",
    ...(chosenPort ? ["-p", chosenPort] : []),
    ...(options?.identity ? ["-i", options.identity] : []),
    ...(options?.jump ? ["-J", options.jump] : []),
    "--", destination,
  ];
}

/** What the probe runs there: the core's own status, which names its id. */
// Found as herdr-core finds a machine's core: `herdr-core` on PATH, then ~/.local/bin/herdr-core
// (and the `hc` alias in both places). Exit 127 when there is none. A target whose shell is not a
// POSIX one (Windows) fails at `sh`, which the probe reports as unsupported.
const CORE_STATUS_COMMAND = "sh -lc 'for c in herdr-core hc \"$HOME/.local/bin/herdr-core\" \"$HOME/.local/bin/hc\"; do "
  + "if command -v \"$c\" >/dev/null 2>&1; then exec \"$c\" server status --json; fi; done; exit 127'";

/**
 * The argv of a batch ssh dial to the machine, the same route herdr-core's
 * update takes (target, port, identity file, jump host or Tailscale SSH), that
 * prints its live core's status. Bound to a short connect timeout.
 */
export function sshProbeArgv(target: string, options: SshOptions | undefined, tailscaleBinary: string | null): string[] {
  const { destination, port } = sshDestination(target);
  if (options?.tailscaleSsh) {
    if (!tailscaleBinary) throw new Error("tailscale is not installed");
    return [tailscaleBinary, "ssh", destination, CORE_STATUS_COMMAND];
  }
  const chosenPort = options?.port ? String(options.port) : port;
  return [
    // Its own connection, as herdr-core's updater opens one: never a ControlMaster the person's ssh
    // config shares, which could still reach the host a name pointed at before.
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    ...(chosenPort ? ["-p", chosenPort] : []),
    ...(options?.identity ? ["-i", options.identity] : []),
    ...(options?.jump ? ["-J", options.jump] : []),
    "--", destination, CORE_STATUS_COMMAND,
  ];
}
