import { createHash } from "node:crypto";
import { SCOPE_RUNTIME_WORKER_HARNESS_VERSION } from "./worker.js";

export const SCOPE_RUNTIME_PROFILE_ID = "scope-runtime-proof-v1";
export const SCOPE_RUNTIME_PROFILE_VERSION = 1;
export const SCOPE_RUNTIME_HARNESS_VERSION = SCOPE_RUNTIME_WORKER_HARNESS_VERSION;

export const SCOPE_ROOT_TOKEN = "<scope-root>";
export const SDK_DIRECTORY_TOKEN = "<sdk-directory>";
export const NATIVE_DIRECTORY_TOKEN = "<native-directory>";
export const WORKER_FILE_TOKEN = "<worker-file>";
export const BROKER_SOCKET_TOKEN = "<broker-socket>";
export const READINESS_FILE_TOKEN = "<readiness-file>";

export const FIXED_SYSTEMD_PROPERTIES = [
  "Type=exec",
  "User=matrix-scope-workload",
  "DynamicUser=yes",
  "PrivateUsers=yes",
  `RootDirectory=${SCOPE_ROOT_TOKEN}`,
  "MountAPIVFS=yes",
  "PrivateNetwork=yes",
  "PrivateIPC=yes",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "ProtectProc=invisible",
  "ProcSubset=pid",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectKernelLogs=yes",
  "ProtectControlGroups=yes",
  "ProtectClock=yes",
  "ProtectHostname=yes",
  "NoNewPrivileges=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "RestrictNamespaces=yes",
  "RestrictRealtime=yes",
  "RestrictSUIDSGID=yes",
  "SystemCallArchitectures=native",
  "MemoryMax=1073741824",
  "CPUQuota=200%",
  "TasksMax=256",
  "TemporaryFileSystem=/workspace:rw,nosuid,nodev,size=10G,mode=1777",
  "TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=64M,mode=1777",
  "BindReadOnlyPaths=/lib",
  "BindReadOnlyPaths=/lib64",
  "BindReadOnlyPaths=/usr/lib",
  "BindReadOnlyPaths=/usr/bin/env",
  "BindReadOnlyPaths=/opt/matrix/runtime/node",
  `BindReadOnlyPaths=${SDK_DIRECTORY_TOKEN}:/opt/matrix/scope-sdk/sdk`,
  `BindReadOnlyPaths=${NATIVE_DIRECTORY_TOKEN}:/opt/matrix/scope-sdk/native`,
  `BindReadOnlyPaths=${WORKER_FILE_TOKEN}:/opt/matrix/scope-runtime/worker.mjs`,
  `BindPaths=${BROKER_SOCKET_TOKEN}:/run/matrix-scope/broker.sock`,
  `BindPaths=${READINESS_FILE_TOKEN}:/run/matrix-scope-readiness/ready`,
  "WorkingDirectory=/workspace",
  "UMask=0077",
  "RuntimeMaxSec=90",
  "TimeoutStopSec=10",
] as const;

export const FIXED_SYSTEMD_ENVIRONMENT = [
  "HOME=/workspace",
  "PATH=/opt/matrix/runtime/node/bin",
  "MATRIX_SCOPE_RUNTIME=1",
] as const;

export const SCOPE_RUNTIME_PROFILE_DIGEST = createHash("sha256")
  .update([...FIXED_SYSTEMD_PROPERTIES, ...FIXED_SYSTEMD_ENVIRONMENT].join("\n") + "\n")
  .digest("hex");

export interface ScopeRuntimeProfilePaths {
  scopeRoot: string;
  sdkDirectory: string;
  nativeDirectory: string;
  workerFile: string;
  brokerSocket: string;
  readinessFile: string;
}

export function materializeFixedSystemdProperties(paths: ScopeRuntimeProfilePaths): string[] {
  const replacements: Readonly<Record<string, string>> = {
    [SCOPE_ROOT_TOKEN]: paths.scopeRoot,
    [SDK_DIRECTORY_TOKEN]: paths.sdkDirectory,
    [NATIVE_DIRECTORY_TOKEN]: paths.nativeDirectory,
    [WORKER_FILE_TOKEN]: paths.workerFile,
    [BROKER_SOCKET_TOKEN]: paths.brokerSocket,
    [READINESS_FILE_TOKEN]: paths.readinessFile,
  };
  return FIXED_SYSTEMD_PROPERTIES.map((property) => {
    let result: string = property;
    for (const [token, value] of Object.entries(replacements)) result = result.replace(token, value);
    return result;
  });
}
