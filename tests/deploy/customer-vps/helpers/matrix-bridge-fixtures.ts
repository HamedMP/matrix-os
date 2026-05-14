export type MessagingBridgeNetwork = "telegram" | "whatsapp";

export interface BridgeSpikeConfig {
  network: MessagingBridgeNetwork;
  bridgeUrl?: string;
  homeserverUrl?: string;
}

export interface BridgeSpikeResult {
  network: MessagingBridgeNetwork;
  passed: boolean;
  checks: Record<string, boolean>;
  reason?: string;
}

export function getBridgeSpikeConfig(network: MessagingBridgeNetwork): BridgeSpikeConfig {
  const prefix = network.toUpperCase();
  return {
    network,
    bridgeUrl: process.env[`MATRIX_MESSAGING_${prefix}_BRIDGE_URL`],
    homeserverUrl: process.env.MATRIX_MESSAGING_HOMESERVER_URL,
  };
}

export async function runBridgeLifecycleSpike(
  config: BridgeSpikeConfig,
): Promise<BridgeSpikeResult> {
  if (!config.bridgeUrl || !config.homeserverUrl) {
    return {
      network: config.network,
      passed: false,
      checks: {
        configured: false,
        inboundText: false,
        outboundText: false,
        restartRecovery: false,
      },
      reason: "missing bridge spike configuration",
    };
  }

  return {
    network: config.network,
    passed: false,
    checks: {
      configured: true,
      inboundText: false,
      outboundText: false,
      restartRecovery: false,
    },
    reason: "bridge lifecycle spike is not implemented yet",
  };
}

export async function runMediaBackfillSpike(
  network: MessagingBridgeNetwork = "telegram",
): Promise<BridgeSpikeResult> {
  return {
    network,
    passed: false,
    checks: {
      mediaPreviewLimits: false,
      originalMediaLimits: false,
      latestHundredBackfill: false,
      resumableBackfill: false,
    },
    reason: "media/backfill spike is not implemented yet",
  };
}

export async function runBackupRestoreSpike(
  network: MessagingBridgeNetwork = "whatsapp",
): Promise<BridgeSpikeResult> {
  return {
    network,
    passed: false,
    checks: {
      homeserverDbRestore: false,
      bridgeDbRestore: false,
      mappingRestore: false,
      whatsappRelinkBoundary: false,
    },
    reason: "backup/restore spike is not implemented yet",
  };
}
