// The core gets connection commands built in main from validated fields. The
// renderer only supplies the destination and the supported SSH options.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SshOptions } from "../../shared/local-terminals";
import { machineNameFor, sshDestination } from "./hc-machines";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function controlPath(root: string, destination: string, port: string | null, options: SshOptions | undefined): string {
  const endpoint = JSON.stringify([destination, port, options?.identity, options?.jump]);
  const key = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
  // Keep room for OpenSSH's temporary suffix on its AF_UNIX socket.
  return join(root, `s-${key}`).replaceAll("%", "%%");
}

/** The line herdr-core uses for Add, installation and subsequent batch dials. */
export function sshVia(
  target: string, options: SshOptions | undefined, tailscaleBinary: string | null, runtimeDir?: string,
): string | null {
  const { destination, port } = sshDestination(target);
  if (options?.tailscaleSsh) {
    if (!tailscaleBinary) throw new Error("tailscale is not installed");
    return `${quote(tailscaleBinary)} ssh ${quote(destination)}`;
  }
  const chosenPort = options?.port ? String(options.port) : port;
  if (destination === target && !chosenPort && !options?.identity && !options?.jump) return null;
  return [
    "ssh", "-o", "BatchMode=yes",
    ...(runtimeDir ? ["-T", "-o", "ConnectTimeout=10", "-S", quote(controlPath(runtimeDir, destination, chosenPort, options)), "-o", "ControlMaster=no"] : []),
    ...(chosenPort ? ["-p", chosenPort] : []),
    ...(options?.identity ? ["-i", quote(options.identity)] : []),
    ...(options?.jump ? ["-J", quote(options.jump)] : []),
    "--", quote(destination),
  ].join(" ");
}

/** An interactive login creates the private master socket used by batch dials. */
export function sshLoginArgv(
  target: string, options: SshOptions | undefined, tailscaleBinary: string | null, runtimeDir?: string,
): string[] {
  const { destination, port } = sshDestination(target);
  if (options?.tailscaleSsh) {
    if (!tailscaleBinary) throw new Error("tailscale is not installed");
    return [tailscaleBinary, "ssh", destination];
  }
  const chosenPort = options?.port ? String(options.port) : port;
  return [
    "ssh",
    ...(runtimeDir ? [
      "-S", controlPath(runtimeDir, destination, chosenPort, options), "-o", "BatchMode=no",
      "-o", "ControlMaster=auto", "-o", "ControlPersist=600",
    ] : []),
    ...(chosenPort ? ["-p", chosenPort] : []),
    ...(options?.identity ? ["-i", options.identity] : []),
    ...(options?.jump ? ["-J", options.jump] : []),
    "--", destination,
  ];
}


/** The private core's interactive Add for a plain SSH target. */
export function herdrMachineAddArgv(binary: string, target: string, name?: string): string[] {
  return [binary, "machine", "add", "--name", name ?? machineNameFor(target), "--", target];
}
