export type ManifestErrorCode =
  | "invalid_manifest"
  | "runtime_version_mismatch"
  | "not_found"
  | "slug_mismatch"
  | "computed_field_not_authored"
  | "install_blocked_by_policy"
  | "install_gated";

export class ManifestError extends Error {
  override readonly name = "ManifestError";
  constructor(
    public readonly code: ManifestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type BuildErrorCode =
  | "install_failed"
  | "build_failed"
  | "timeout"
  | "lockfile_tampered"
  | "disk_full"
  | "hash_mismatch";

export class BuildError extends Error {
  override readonly name = "BuildError";
  constructor(
    public readonly code: BuildErrorCode,
    public readonly stage: "install" | "build" | "prepare",
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(`${code} during ${stage} (exit ${exitCode}): ${stderrTail.slice(-200)}`);
  }
}

export type SpawnErrorCode =
  | "spawn_failed"
  | "startup_timeout"
  | "health_check_failed"
  | "port_exhausted";

export class SpawnError extends Error {
  override readonly name = "SpawnError";
  constructor(
    public readonly code: SpawnErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class HealthCheckError extends Error {
  override readonly name = "HealthCheckError";
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export type ProxyErrorCode =
  | "backend_timeout"
  | "backend_unreachable"
  | "backend_5xx"
  | "upstream_closed";

export class ProxyError extends Error {
  override readonly name = "ProxyError";
  constructor(
    public readonly code: ProxyErrorCode,
    public readonly correlationId: string,
    message: string,
  ) {
    super(message);
  }
}
