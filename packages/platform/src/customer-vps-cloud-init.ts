import { readFile } from 'node:fs/promises';

export interface CustomerHostConfig {
  machineId: string;
  clerkUserId: string;
  handle: string;
  imageVersion: string;
  platformRegisterUrl: string;
  registrationToken: string;
  r2Bucket: string;
  r2Prefix: `matrixos-sync/${string}/`;
  postgresPassword: string;
}

const SECRET_KEYS = ['registrationToken', 'postgresPassword'] as const;

function assertRenderable(input: CustomerHostConfig): void {
  for (const key of SECRET_KEYS) {
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

export function redactCloudInitSecrets(value: string, input: CustomerHostConfig): string {
  let redacted = value;
  for (const key of SECRET_KEYS) {
    redacted = redacted.replaceAll(input[key], '[redacted]');
  }
  return redacted;
}

