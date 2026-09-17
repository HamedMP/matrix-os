type RuntimeVersions = NodeJS.ProcessVersions & {
  bun?: string;
};

const bakedStandaloneMarker = process.env.MATRIX_CLI_STANDALONE;

export function isStandaloneRuntime(
  env?: NodeJS.ProcessEnv,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  const standaloneMarker = env === undefined
    ? bakedStandaloneMarker
    : env.MATRIX_CLI_STANDALONE;
  return standaloneMarker === "1" && typeof versions.bun === "string";
}

export function shouldRunStandaloneDaemon(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs[0] === "__daemon" && isStandaloneRuntime(env, versions);
}

export function shouldRunDesktopEnrollment(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs.length === 1
    && rawArgs[0] === "__desktop-enroll"
    && isStandaloneRuntime(env, versions);
}

export function shouldRunDesktopReauthorization(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs.length === 1
    && rawArgs[0] === "__desktop-reauthorize"
    && isStandaloneRuntime(env, versions);
}

export function shouldRunDesktopActivation(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs.length === 1
    && rawArgs[0] === "__desktop-activate"
    && isStandaloneRuntime(env, versions);
}

export function shouldRunDesktopRevocation(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs.length === 1
    && rawArgs[0] === "__desktop-revoke"
    && isStandaloneRuntime(env, versions);
}
