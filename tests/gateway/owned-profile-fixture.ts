import { resolveScopeRuntimeHostConfig } from "@matrix-os/scope-runtime/host-config";
import { createGatewayScopeRuntimeProfilePolicy } from "../../packages/gateway/src/collaboration/scope-runtime-profile-policy.js";

export function ownedProfileFixture(namespace = "profile-a") {
  const root = `/var/lib/matrix-devstack/${namespace}`;
  const env = {
    MATRIX_SCOPE_RUNTIME_NAMESPACE: namespace,
    MATRIX_SCOPE_RUNTIME_APP_ROOT: root + "/app",
    MATRIX_SCOPE_RUNTIME_NODE_ROOT: root + "/runtime/node",
    MATRIX_HOME: root + "/home",
  };
  const config = resolveScopeRuntimeHostConfig({ env });
  return { env, config, policy: createGatewayScopeRuntimeProfilePolicy(config) };
}
