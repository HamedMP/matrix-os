import type { CustomerVpsConfig } from './customer-vps-config.js';
import type { ProvisionRequest } from './customer-vps-schema.js';
import type { HostBundleRef } from './customer-vps-host-bundle.js';
import type { CustomerHostConfig } from './customer-vps-cloud-init.js';
import type { UserMachineProvisioningClass } from './db.js';
import {
  buildPlatformRuntimeVerificationToken,
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformSyncVerificationToken,
  buildPlatformVerificationToken,
} from './platform-token.js';
import { DEFAULT_DEVELOPER_TOOLS, developerToolsShellList } from './developer-tools.js';

export const DEFAULT_CLOUD_INIT_TEMPLATE = [
  '#cloud-config',
  'write_files:',
  '  - path: /opt/matrix/env/host.env',
  '    content: |',
  '      MATRIX_MACHINE_ID={{machineId}}',
  '      MATRIX_CLERK_USER_ID={{clerkUserId}}',
  '      MATRIX_HANDLE={{handle}}',
  '      MATRIX_RUNTIME_SLOT={{runtimeSlot}}',
  '      MATRIX_RUNTIME_TOKEN_EPOCH={{runtimeTokenEpoch}}',
  '      MATRIX_NODE_PREFIX=/opt/matrix/runtime/node',
  "      MATRIX_DEVELOPER_TOOLS='{{developerTools}}'",
  '      MATRIX_IMAGE_VERSION={{imageVersion}}',
  '      MATRIX_UPDATE_CHANNEL={{updateChannel}}',
  '      MATRIX_IMAGE_SOURCE={{imageSource}}',
  '      MATRIX_TARGET_BUNDLE_SHA256={{targetBundleSha256}}',
  '      MATRIX_SNAPSHOT_SOURCE_VERSION={{snapshotSourceVersion}}',
  '      MATRIX_HOST_BUNDLE_URL={{hostBundleUrl}}',
  '      MATRIX_PLATFORM_REGISTER_URL={{platformRegisterUrl}}',
  '      PLATFORM_INTERNAL_URL={{platformInternalUrl}}',
  '      {{updateManifestBaseUrlEnv}}',
  '      {{collaborationDisabledEnv}}',
  '      UPGRADE_TOKEN={{platformVerificationToken}}',
  '      MATRIX_AUTH_TOKEN={{platformVerificationToken}}',
  '      MATRIX_SYNC_RUNTIME_TOKEN={{syncRuntimeToken}}',
  '      MATRIX_FUNDED_AI_RUNTIME_TOKEN={{fundedAiRuntimeToken}}',
  '      MATRIX_PLATFORM_SPEECH_ENABLED={{platformSpeechEnabled}}',
  '      MATRIX_PLATFORM_SPEECH_ORIGIN={{platformSpeechOrigin}}',
  '      MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN={{platformSpeechRuntimeToken}}',
  // On-host nginx is the only trusted proxy: forwarded client-IP headers
  // are honored solely from loopback peers (see gateway auth.ts).
  '      MATRIX_TRUSTED_PROXIES=127.0.0.1,::1',
  '      MATRIX_CODE_PROXY_TOKEN={{platformVerificationToken}}',
  '      MATRIX_FUNDED_AI_ENABLED={{fundedAiEnabled}}',
  '      MATRIX_FUNDED_AI_RELAY_URL={{fundedAiRelayUrl}}',
  '      POSTHOG_TOKEN={{posthogToken}}',
  '      POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      POSTHOG_HOST={{posthogHost}}',
  '      NEXT_PUBLIC_POSTHOG_KEY={{posthogToken}}',
  '      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      NEXT_PUBLIC_POSTHOG_HOST={{posthogPublicHost}}',
  '      NEXT_PUBLIC_POSTHOG_API_HOST={{posthogApiHost}}',
  '      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix',
  '  - path: /opt/matrix/env/postgres.env',
  '    permissions: "0640"',
  '    content: |',
  '      POSTGRES_DB=matrix',
  '      POSTGRES_USER=matrix',
  '      POSTGRES_PASSWORD={{postgresPassword}}',
  '  - path: /opt/matrix/env/registration.env',
  '    permissions: "0640"',
  '    content: |',
  '      MATRIX_REGISTRATION_TOKEN={{registrationToken}}',
  '      MATRIX_REGISTRATION_TOKEN_EXPIRES_AT={{registrationTokenExpiresAt}}',
].join('\n');


export function buildHostConfig(
  config: CustomerVpsConfig,
  input: ProvisionRequest & { provisioningClass?: UserMachineProvisioningClass },
  machineId: string,
  registrationToken: string,
  registrationTokenExpiresAt: string,
  postgresPassword: string,
  bundleRef: HostBundleRef,
  runtimeTokenEpoch = 1,
): CustomerHostConfig {
  const platformInternalUrl = new URL(config.platformRegisterUrl).origin;
  // Spec 537: a Private Preview's updater may fetch only its owner-confirmed
  // release, and its gateway never joins collaboration. Other classes get no
  // line at all, since an empty assignment would override the updater fallback.
  const privatePreview = input.provisioningClass === 'private-preview';
  const runtimeIdentity = {
    handle: input.handle,
    machineId,
    runtimeSlot: input.runtimeSlot,
  };
  return {
    machineId,
    clerkUserId: input.clerkUserId,
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    runtimeTokenEpoch: String(runtimeTokenEpoch),
    developerTools: developerToolsShellList(input.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    imageVersion: bundleRef.imageVersion,
    updateChannel: config.imageVersion,
    hostBundleUrl: bundleRef.hostBundleUrl,
    platformRegisterUrl: config.platformRegisterUrl,
    platformInternalUrl,
    platformVerificationToken: buildPlatformVerificationToken(input.handle, config.platformSecret),
    syncRuntimeToken: buildPlatformSyncVerificationToken(runtimeIdentity, config.platformSecret, runtimeTokenEpoch),
    fundedAiRuntimeToken: buildPlatformRuntimeVerificationToken(runtimeIdentity, config.platformSecret, runtimeTokenEpoch),
    platformSpeechEnabled: String(config.platformSpeechEnabled),
    platformSpeechOrigin: platformInternalUrl,
    platformSpeechRuntimeToken: buildPlatformSpeechRuntimeVerificationToken(runtimeIdentity, config.platformSecret, runtimeTokenEpoch),
    registrationToken,
    registrationTokenExpiresAt,
    postgresPassword,
    posthogToken: config.posthogToken,
    posthogProjectToken: config.posthogProjectToken,
    posthogHost: config.posthogHost,
    posthogPublicHost: config.posthogPublicHost,
    posthogApiHost: config.posthogApiHost,
    fundedAiEnabled: config.fundedAiEnabled ? 'true' : 'false',
    fundedAiRelayUrl: config.fundedAiRelayUrl,
    updateManifestBaseUrlEnv: privatePreview
      ? `MATRIX_UPDATE_MANIFEST_BASE_URL=${platformInternalUrl}/private-preview-updates/${input.handle}`
      : '',
    collaborationDisabledEnv: privatePreview ? 'MATRIX_COLLABORATION_DISABLED=1' : '',
  };
}
