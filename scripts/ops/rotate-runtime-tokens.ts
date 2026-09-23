/** Operator-only two-phase rotation. Secret material is read from protected files, never argv. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  buildPlatformRuntimeVerificationToken,
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformSyncVerificationToken,
  buildPlatformVerificationToken,
} from '../../packages/platform/src/platform-token.ts';
import { encryptRuntimeTokenRotation } from './runtime-token-envelope.mjs';
import { targetRuntimeTokenEpoch } from './runtime-token-epoch.mjs';

type Machine = {
  machine_id: string;
  handle: string;
  runtime_slot: string;
  runtime_token_epoch: number;
  status: string;
  deleted_at: string | null;
};
type Database = { user_machines: Machine };

async function protectedText(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 65536 || (info.mode & 0o077)) throw new Error('Unsafe input file');
  return readFile(path, 'utf8');
}

function flags(): Record<string, string> {
  const args = process.argv.slice(2);
  const action = args.shift();
  if (action !== 'prepare' && action !== 'prepare-recovery' && action !== 'activate') throw new Error('Expected prepare, prepare-recovery, or activate');
  if (args.length % 2) throw new Error('Expected flag/value pairs');
  const values: Record<string, string> = { action };
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || values[args[i].slice(2)]) throw new Error('Invalid flag');
    values[args[i].slice(2)] = args[i + 1];
  }
  const required = action === 'prepare'
    ? ['machine-id', 'db-file', 'secret-file', 'public-key-file', 'verifier-digest', 'out']
    : action === 'prepare-recovery'
      ? ['machine-id', 'db-file', 'secret-file', 'public-key-file', 'verifier-digest', 'host-epoch', 'out']
      : ['machine-id', 'db-file', 'expected-epoch'];
  if (Object.keys(values).length !== required.length + 1 || required.some((key) => !values[key])) {
    throw new Error('Invalid rotation arguments');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(values['machine-id'])) throw new Error('Invalid machine id');
  return values;
}

async function main(): Promise<void> {
  const options = flags();
  const connectionString = (await protectedText(options['db-file'])).trim();
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  try {
    const machine = await db.selectFrom('user_machines')
      .select(['machine_id', 'handle', 'runtime_slot', 'runtime_token_epoch', 'status', 'deleted_at'])
      .where('machine_id', '=', options['machine-id'])
      .executeTakeFirst();
    if (!machine || machine.status !== 'running' || machine.deleted_at !== null) throw new Error('Machine is not active');
    if (options.action === 'prepare' || options.action === 'prepare-recovery') {
      const targetEpoch = targetRuntimeTokenEpoch(
        machine.runtime_token_epoch,
        options.action,
        options.action === 'prepare-recovery' ? Number(options['host-epoch']) : undefined,
      );
      const secret = await protectedText(options['secret-file']);
      if (secret.length < 32 || secret !== secret.trim() || /[\r\n\0]/.test(secret)) {
        throw new Error('Invalid platform secret file');
      }
      const digest = options['verifier-digest'];
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid host verifier digest');
      const expectedDigest = createHash('sha256')
        .update(buildPlatformVerificationToken(machine.handle, secret))
        .digest('hex');
      if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedDigest, 'hex'))) {
        throw new Error('Platform secret does not match selected host');
      }
      const publicKey = await protectedText(options['public-key-file']);
      const identity = { handle: machine.handle, machineId: machine.machine_id, runtimeSlot: machine.runtime_slot };
      const envelope = encryptRuntimeTokenRotation({
        machineId: machine.machine_id,
        runtimeSlot: machine.runtime_slot,
        epoch: targetEpoch,
        tokens: {
          sync: buildPlatformSyncVerificationToken(identity, secret, targetEpoch),
          fundedAi: buildPlatformRuntimeVerificationToken(identity, secret, targetEpoch),
          speech: buildPlatformSpeechRuntimeVerificationToken(identity, secret, targetEpoch),
        },
      }, publicKey);
      await writeFile(options.out, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Prepared encrypted runtime token epoch ${targetEpoch}.\n`);
      return;
    }
    const nextEpoch = targetRuntimeTokenEpoch(machine.runtime_token_epoch, 'prepare');
    const expected = Number(options['expected-epoch']);
    if (!Number.isSafeInteger(expected) || expected !== nextEpoch) throw new Error('Unexpected epoch');
    const changed = await db.updateTable('user_machines')
      .set({ runtime_token_epoch: expected })
      .where('machine_id', '=', machine.machine_id)
      .where('runtime_token_epoch', '=', machine.runtime_token_epoch)
      .where('status', '=', 'running')
      .where('deleted_at', 'is', null)
      .returning('runtime_token_epoch')
      .executeTakeFirst();
    if (!changed) throw new Error('Concurrent change prevented rotation');
    process.stdout.write(`Activated runtime token epoch ${changed.runtime_token_epoch}.\n`);
  } finally {
    await db.destroy();
  }
}

main().catch(() => { process.stderr.write('Runtime token rotation failed. Check private operator logs.\n'); process.exitCode = 1; });
