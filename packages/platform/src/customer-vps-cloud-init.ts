import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CustomerHostConfig {
  machineId: string;
  clerkUserId: string;
  handle: string;
  imageVersion: string;
  hostBundleUrl: string;
  platformRegisterUrl: string;
  platformVerificationToken: string;
  registrationToken: string;
  r2Bucket: string;
  r2Prefix: `matrixos-sync/${string}/`;
  postgresPassword: string;
}

const SECRET_KEYS = ['registrationToken', 'postgresPassword', 'platformVerificationToken'] as const;
const REQUIRED_KEYS = ['hostBundleUrl', ...SECRET_KEYS] as const;

function assertRenderable(input: CustomerHostConfig): void {
  for (const key of REQUIRED_KEYS) {
    if (!input[key]) throw new Error(`Missing ${key}`);
  }
}

export function renderCloudInitTemplate(template: string, input: CustomerHostConfig): string {
  assertRenderable(input);
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, rawKey: string) => {
    const key = rawKey as keyof CustomerHostConfig;
    const value = input[key];
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
