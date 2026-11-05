import { selectOwnedNode, type OwnedNode } from "./node-runtime.js";
export { closeOwnedListener, finishCloses, retryableClose, socketIdentity } from "./socket-shutdown.js";
export { HOST_NAMESPACE_TRUST, assertNamespaceDirectory, assertNamespaceSocket, type NamespacePathTrust } from "./namespace-ancestry.js";
import { join } from "node:path";
import { createScopeRuntimeUnitIdentity } from "./systemd-unit-identity.js";

export interface ScopeRuntimeHostConfig {
  namespace?: string;
  ownedNode?: OwnedNode;
  appRoot: string;
  runtimeDirectory: string;
  stateRoot: string;
  supervisorSocket: string;
  brokerSocket: string;
  workerUnitPrefix: string;
  supervisorUnit: string;
  commandSocketRoot?: string;
}

/** Fail closed before sockets, filesystem writes or systemd commands are attempted. */
export function resolveScopeRuntimeHostConfig(options: {
  env: Readonly<Record<string, string | undefined>>;
  homePath?: string;
}): ScopeRuntimeHostConfig {
  const { env, homePath } = options;
  const namespace = env.MATRIX_SCOPE_RUNTIME_NAMESPACE;
  const identity = createScopeRuntimeUnitIdentity(namespace);
  if (homePath !== undefined && env.MATRIX_HOME !== undefined && homePath !== env.MATRIX_HOME) {
    throw new Error("Scope runtime home configuration disagrees");
  }
  const appOverride = env.MATRIX_SCOPE_RUNTIME_APP_ROOT;
  if (namespace === undefined && appOverride !== undefined) {
    throw new Error("Scope runtime app root requires a namespace");
  }
  const base = namespace === undefined ? undefined : `/var/lib/matrix-devstack/${namespace}`;
  if (base !== undefined && (appOverride !== `${base}/app` || (homePath ?? env.MATRIX_HOME) !== `${base}/home`)) {
    throw new Error("Scope runtime namespace requires canonical isolated app and home roots");
  }
  const ownedNode = selectOwnedNode(namespace, env.MATRIX_SCOPE_RUNTIME_NODE_ROOT);
  const runtimeDirectory = namespace === undefined
    ? "/run/matrix-scope-runtime" : `/run/matrix-devstack/${namespace}/scope-runtime`;
  return {
    ...(ownedNode ? { ownedNode } : {}),
    ...(namespace === undefined ? {} : { namespace, commandSocketRoot: `/run/matrix-devstack/${namespace}/c` }),
    appRoot: appOverride ?? "/opt/matrix/app",
    runtimeDirectory,
    stateRoot: base === undefined ? "/var/lib/matrix-scope-runtime" : `${base}/scope-runtime`,
    supervisorSocket: `${runtimeDirectory}/supervisor.sock`,
    brokerSocket: `${runtimeDirectory}/broker.sock`,
    workerUnitPrefix: identity.workerUnitPrefix,
    supervisorUnit: identity.supervisorUnit,
  };
}

/** Native package selection stays Linux-only, matching the supervisor's systemd host. */
export function resolveScopeRuntimeSourcePaths(config: Pick<ScopeRuntimeHostConfig, "appRoot">, architecture: string = process.arch) {
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Unsupported scope runtime architecture");
  return {
    sdkDirectory: join(config.appRoot, "node_modules/@anthropic-ai/claude-agent-sdk"),
    nativeDirectory: join(config.appRoot, `node_modules/@anthropic-ai/claude-agent-sdk-linux-${architecture}`),
    workerFile: join(config.appRoot, "packages/scope-runtime/dist/worker.js"),
    botRuntimeDirectory: join(config.appRoot, "packages/bot-runtime/dist"),
  };
}
