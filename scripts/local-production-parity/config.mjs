import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function resolveParityStateDirectory(projectRoot) {
  const current = resolve(projectRoot, ".local/production-parity");
  const legacy = resolve(projectRoot, ".amp/in/local-production-parity");
  if (existsSync(current) && existsSync(legacy)) throw new Error("Two local parity directories exist; choose the retained environment before launching");
  // Preserve absolute qcow2 backing paths, Docker mounts and the lock inode.
  return existsSync(legacy) ? legacy : current;
}
export const stateDirectory = resolveParityStateDirectory(root);
export const statePath = resolve(stateDirectory, "state.json");
export const bundleDirectory = resolve(stateDirectory, "host-bundle");
export const cloudInitPath = resolve(stateDirectory, "cloud-init.yaml");
export const bundlePath = resolve(bundleDirectory, "matrix-host-bundle.tar.gz");
export const bundleChecksumPath = `${bundlePath}.sha256`;
export const machineName = process.env.MATRIX_PARITY_MACHINE_NAME ?? "matrix-os-local";
export const launcherLockPath = resolve(stateDirectory, "launcher.lock");
export const runtimeDirectory = resolve(stateDirectory, "runtime");
export const runtimeDiskPath = resolve(runtimeDirectory, "disk.qcow2");
export const runtimeSeedPath = resolve(runtimeDirectory, "cidata.iso");
export const runtimePidPath = resolve(runtimeDirectory, "qemu.pid");
export const runtimeLogPath = resolve(runtimeDirectory, "serial.log");
export const runtimeSshKeyPath = resolve(runtimeDirectory, "operator_ed25519");
export const storageTlsDirectory = resolve(stateDirectory, "storage-tls");
export const storageTlsCertificatePath = resolve(storageTlsDirectory, "certificate.pem");
export const storageTlsKeyPath = resolve(storageTlsDirectory, "key.pem");
export const baseImagePath = resolve(stateDirectory, "ubuntu-24.04-amd64.qcow2");
export const baseImageChecksumPath = `${baseImagePath}.sha256`;
export const artifactPort = Number(process.env.MATRIX_PARITY_ARTIFACT_PORT ?? 9876);
// Keep parity isolated from the source/HMR platform's conventional port 9000.
export const platformPort = Number(process.env.MATRIX_PARITY_PLATFORM_PORT ?? 9003);
export const storageTlsPort = Number(process.env.MATRIX_PARITY_STORAGE_TLS_PORT ?? 9444);
export const guestHostAddress = "10.0.2.2";
export const fixturePublicAddress = "192.0.2.2";
export const localPlatformUrl = `http://${guestHostAddress}:${platformPort}`;
export const localArtifactUrl = `http://${guestHostAddress}:${artifactPort}`;
export const ubuntuImageUrl = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
export const fixtureRouterName = "matrix-os-parity-router";
export const storageTlsProxyName = "matrix-os-parity-storage-tls";
export const platformContainerName = "matrix-os-parity-platform";
export const platformImageName = "matrix-os-parity-platform:working-tree";
export const LOCAL_PARITY_OWNER_LABEL = "com.matrix-os.local-production-parity.root";
