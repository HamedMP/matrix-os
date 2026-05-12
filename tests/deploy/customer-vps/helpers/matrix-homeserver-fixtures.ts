export type HomeserverCandidate = "conduit" | "synapse";

export interface HomeserverSpikeConfig {
  candidate: HomeserverCandidate;
  baseUrl?: string;
  appserviceToken?: string;
}

export interface HomeserverSpikeResult {
  candidate: HomeserverCandidate;
  passed: boolean;
  checks: Record<string, boolean>;
  reason?: string;
}

export function messagingSpikesEnabled(): boolean {
  return process.env.RUN_MATRIX_MESSAGING_SPIKES === "1";
}

export function getHomeserverSpikeConfig(candidate: HomeserverCandidate): HomeserverSpikeConfig {
  const prefix = candidate.toUpperCase();
  return {
    candidate,
    baseUrl: process.env[`MATRIX_MESSAGING_${prefix}_URL`],
    appserviceToken: process.env[`MATRIX_MESSAGING_${prefix}_APPSERVICE_TOKEN`],
  };
}

export async function runHomeserverAppserviceSpike(
  config: HomeserverSpikeConfig,
): Promise<HomeserverSpikeResult> {
  if (!config.baseUrl || !config.appserviceToken) {
    return {
      candidate: config.candidate,
      passed: false,
      checks: {
        configured: false,
        appserviceRegistration: false,
        namespaceControl: false,
        restartRecovery: false,
      },
      reason: "missing homeserver spike configuration",
    };
  }

  return {
    candidate: config.candidate,
    passed: false,
    checks: {
      configured: true,
      appserviceRegistration: false,
      namespaceControl: false,
      restartRecovery: false,
    },
    reason: "homeserver appservice spike is not implemented yet",
  };
}
