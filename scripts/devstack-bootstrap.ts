#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlatformDb, type PlatformDB } from '../packages/platform/src/db.js';
import { assertLocalDevstackDatabase, bootstrapDevstackIdentity, parseDevstackBootstrapInput } from '../packages/platform/src/devstack-bootstrap.js';

const usage = `Usage: PLATFORM_RUNTIME_MODE=local PLATFORM_DATABASE_URL=<local-instance-url> pnpm exec tsx scripts/devstack-bootstrap.ts
  --instance <slug> --clerk-user-id <id> --handle <handle> --email <email>
  --container-id <64-lowercase-hex-docker-id> [--display-name <name>]
  [--gateway-port <port>] [--shell-port <port>]

The database must already exist at literal loopback and be named
matrixos_devstack_<instance>, with instance hyphens replaced by underscores.
This command initializes local identity/routing only. It does not provision a
computer, configure external projects, enable auth bypasses, or grant credits.`;

export async function runDevstackBootstrap(options: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  openDatabase?: (url: string) => PlatformDB;
} = {}) {
  const { values } = parseArgs({ args: options.args ?? process.argv.slice(2), strict: true, allowPositionals: false,
    options: { help: { type: 'boolean' }, instance: { type: 'string' },
      'clerk-user-id': { type: 'string' }, handle: { type: 'string' }, email: { type: 'string' },
      'display-name': { type: 'string' }, 'container-id': { type: 'string' },
      'gateway-port': { type: 'string', default: '4000' }, 'shell-port': { type: 'string', default: '3000' } } });
  if (values.help) return { usage };
  const env = options.env ?? process.env;
  const databaseUrl = assertLocalDevstackDatabase(env.PLATFORM_DATABASE_URL ?? '', values.instance ?? '', env.PLATFORM_RUNTIME_MODE);
  const input = parseDevstackBootstrapInput({
    instance: values.instance ?? '', clerkUserId: values['clerk-user-id'] ?? '',
    handle: values.handle ?? '', email: values.email ?? '', displayName: values['display-name'],
    containerId: values['container-id'] ?? '', gatewayPort: Number(values['gateway-port']), shellPort: Number(values['shell-port']),
  });
  const db = (options.openDatabase ?? createPlatformDb)(databaseUrl);
  try {
    await db.ready;
    return await bootstrapDevstackIdentity(db, input);
  } finally { await db.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receipt = await runDevstackBootstrap();
    console.log('usage' in receipt ? receipt.usage : JSON.stringify(receipt, null, 2));
  } catch (error: unknown) {
    const known = error instanceof Error && error.name === 'DevstackBootstrapError';
    console.error(known ? error.message : 'DevStack bootstrap failed; check the local database and registration configuration.');
    process.exitCode = 1;
  }
}
