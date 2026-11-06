import { isDeepStrictEqual } from "node:util";
import { HOST_NAMESPACE_TRUST, resolveScopeRuntimeHostConfig } from "@matrix-os/scope-runtime/host-config";
import { SCOPE_RUNTIME_PROFILE_ID } from "@matrix-os/scope-runtime/profile";
import {
  createGatewayScopeRuntimeProfilePolicy,
  LEGACY_SCOPE_RUNTIME_PROFILE_POLICY,
} from "../collaboration/scope-runtime-profile-policy.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { createScopeRuntimeHost, type ScopeRuntimeHost } from "./index.js";

export function resolveGatewayScopeRuntimeDeployment(homePath: string) {
  const resolved = resolveScopeRuntimeHostConfig({ env: process.env, homePath });
  if (resolved.ownedNode) Object.freeze(resolved.ownedNode);
  const config = Object.freeze(resolved);
  const policy = createGatewayScopeRuntimeProfilePolicy(config);
  return Object.freeze({ homePath, config, policy });
}

export type GatewayScopeRuntimeDeployment = ReturnType<typeof resolveGatewayScopeRuntimeDeployment>;

interface RuntimeHostOptions {
  homePath: string;
  deployment?: GatewayScopeRuntimeDeployment;
  supervisorSocket?: string;
  brokerSocket?: string;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
}

function hostOptions(options: RuntimeHostOptions, deployment: GatewayScopeRuntimeDeployment) {
  const { config, policy } = deployment;
  if (options.homePath !== deployment.homePath) throw new Error("Scope runtime home configuration disagrees");
  if (config.namespace !== undefined && (
    (options.supervisorSocket !== undefined && options.supervisorSocket !== config.supervisorSocket)
    || (options.brokerSocket !== undefined && options.brokerSocket !== config.brokerSocket)
  )) throw new Error("Namespaced scope runtime socket configuration disagrees");
  return {
    homePath: deployment.homePath,
    profileCatalog: policy.catalog,
    supervisorSocket: options.supervisorSocket ?? config.supervisorSocket,
    brokerSocket: options.brokerSocket ?? config.brokerSocket,
    ...(config.namespace !== undefined ? { namespaceTrust: HOST_NAMESPACE_TRUST } : {}),
    ...(options.fundedCredentialProvider ? { fundedCredentialProvider: options.fundedCredentialProvider } : {}),
    ...(options.fundedAdmission ? { fundedAdmission: options.fundedAdmission } : {}),
  };
}

export function createDeploymentHost(options: RuntimeHostOptions, deployment: GatewayScopeRuntimeDeployment) {
  return createScopeRuntimeHost(hostOptions(options, deployment));
}

/** The supplied host's local construction inputs, never its advertisement, identify its trust boundary. */
export async function acquireSharedAiHost(options: RuntimeHostOptions & { host?: ScopeRuntimeHost }) {
  const deployment = options.deployment ?? resolveGatewayScopeRuntimeDeployment(options.homePath);
  const expected = hostOptions(options, deployment);
  if (!options.host) {
    const ownedHost = await createScopeRuntimeHost(expected);
    return { host: ownedHost, ownedHost, profilePolicy: deployment.policy };
  }
  const profilePolicy = options.deployment?.policy ?? LEGACY_SCOPE_RUNTIME_PROFILE_POLICY;
  const placement = options.host.placement;
  const checkSockets = deployment.config.namespace !== undefined || options.deployment !== undefined;
  if (!placement || placement.homePath !== expected.homePath
    || ((checkSockets || options.supervisorSocket !== undefined) && placement.supervisorSocket !== expected.supervisorSocket)
    || ((checkSockets || options.brokerSocket !== undefined) && placement.brokerSocket !== expected.brokerSocket)
    || (deployment.config.namespace !== undefined && placement.namespaceTrust !== HOST_NAMESPACE_TRUST)
    || !placement.profileCatalog[SCOPE_RUNTIME_PROFILE_ID]
    || !Object.entries(placement.profileCatalog).every(([id, entry]) => isDeepStrictEqual(entry, profilePolicy.catalog[id]))) {
    throw new Error("Supplied scope runtime host disagrees with deployment");
  }
  return { host: options.host, ownedHost: undefined, profilePolicy };
}
