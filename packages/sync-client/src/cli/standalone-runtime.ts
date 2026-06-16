type RuntimeVersions = NodeJS.ProcessVersions & {
  bun?: string;
};

export function isStandaloneRuntime(
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return env.MATRIX_CLI_STANDALONE === "1" && typeof versions.bun === "string";
}

export function shouldRunStandaloneDaemon(
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions as RuntimeVersions,
): boolean {
  return rawArgs[0] === "__daemon" && isStandaloneRuntime(env, versions);
}
