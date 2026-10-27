import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CustomerHostConfig {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  runtimeTokenEpoch: string;
  developerTools: string;
  imageVersion: string;
  updateChannel: string;
  hostBundleUrl: string;
  platformRegisterUrl: string;
  platformInternalUrl: string;
  platformVerificationToken: string;
  syncRuntimeToken: string;
  fundedAiRuntimeToken: string;
  platformSpeechEnabled: string;
  platformSpeechOrigin: string;
  platformSpeechRuntimeToken: string;
  registrationToken: string;
  registrationTokenExpiresAt: string;
  postgresPassword: string;
  posthogToken: string;
  posthogProjectToken: string;
  posthogHost: string;
  posthogPublicHost: string;
  posthogApiHost: string;
  fundedAiEnabled: string;
  fundedAiRelayUrl: string;
  getStartedEnabled: string;
  imageSource?: 'snapshot' | 'clean_image';
  targetBundleSha256?: string;
  snapshotSourceVersion?: string;
  /** Whole host.env lines for Private Previews only; empty for every other class. */
  updateManifestBaseUrlEnv?: string;
  collaborationDisabledEnv?: string;
  /** Server-authoritative runtime marker for shared and owner-only PR Preview machines. */
  previewRuntimeEnv?: string;
  supportPublicKey?: string;
}

const SECRET_KEYS = [
  'registrationToken',
  'postgresPassword',
  'platformVerificationToken',
  'syncRuntimeToken',
  'fundedAiRuntimeToken',
  'platformSpeechRuntimeToken',
] as const;
const REQUIRED_KEYS = ['hostBundleUrl', 'registrationTokenExpiresAt', ...SECRET_KEYS] as const;

function assertRenderable(input: CustomerHostConfig): void {
  for (const key of REQUIRED_KEYS) {
    if (!input[key]) throw new Error(`Missing ${key}`);
  }
}

/** Validate the SSH wire format as well as the one-line authorized_keys form. */
export function validateSupportPublicKey(value: string): string {
  const key = value.endsWith('\n') ? value.slice(0, -1) : value;
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [A-Za-z0-9@._+-]{1,128})?$/.exec(key);
  if (!match || key.length > 1023) throw new Error('Support SSH public key is missing or invalid');
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.length !== 51 || decoded.readUInt32BE(0) !== 11
    || decoded.subarray(4, 15).toString('ascii') !== 'ssh-ed25519'
    || decoded.readUInt32BE(15) !== 32
    || decoded.toString('base64') !== match[1]) {
    throw new Error('Support SSH public key is missing or invalid');
  }
  return key;
}

export function renderCloudInitTemplate(template: string, input: CustomerHostConfig): string {
  assertRenderable(input);
  // The production template must never deliver unvalidated operator input as YAML.
  const supportPublicKey = template.includes('{{supportPublicKey}}')
    ? validateSupportPublicKey(input.supportPublicKey ?? '')
    : undefined;
  const optionalDefaults: Partial<Record<keyof CustomerHostConfig, string>> = {
    imageSource: 'clean_image',
    targetBundleSha256: '',
    snapshotSourceVersion: '',
    updateManifestBaseUrlEnv: '',
    collaborationDisabledEnv: '',
    previewRuntimeEnv: '',
  };
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, rawKey: string) => {
    const key = rawKey as keyof CustomerHostConfig;
    const value = key === 'supportPublicKey' ? supportPublicKey : input[key] ?? optionalDefaults[key];
    if (typeof value !== 'string') return match;
    return value;
  });
}

export async function renderCloudInitFile(path: string, input: CustomerHostConfig): Promise<string> {
  return renderCloudInitTemplate(await readFile(path, 'utf8'), input);
}

export async function loadCustomerVpsCloudInitTemplate(
  path = process.env.CUSTOMER_VPS_CLOUD_INIT_PATH ?? 'distro/customer-vps/cloud-init.yaml',
): Promise<string> {
  return await readFile(resolve(process.cwd(), path), 'utf8');
}

export function redactCloudInitSecrets(value: string, input: CustomerHostConfig): string {
  let redacted = value;
  for (const key of SECRET_KEYS) {
    redacted = redacted.replaceAll(input[key], '[redacted]');
  }
  return redacted;
}
