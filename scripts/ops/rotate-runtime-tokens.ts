/** Operator-only two-phase rotation. Secret material is read from protected files, never argv. */
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  buildPlatformRuntimeVerificationToken,
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformSyncVerificationToken,
} from '../../packages/platform/src/platform-token.ts';
import { encryptRuntimeTokenRotation } from '../../distro/customer-vps/host-bin/matrix-rotate-runtime-tokens.mjs';

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
  if (action !== 'prepare' && action !== 'activate') throw new Error('Expected prepare or activate');
  if (args.length % 2) throw new Error('Expected flag/value pairs');
  const values: Record<string, string> = { action };
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || values[args[i].slice(2)]) throw new Error('Invalid flag');
    values[args[i].slice(2)] = args[i + 1];
  }
  const required = action === 'prepare'
    ? ['machine-id', 'db-file', 'secret-file', 'public-key-file', 'out']
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
    const nextEpoch = machine.runtime_token_epoch + 1;
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch > 2147483647) throw new Error('Epoch limit reached');
    if (options.action === 'prepare') {
      const secret = await protectedText(options['secret-file']);
      const publicKey = await protectedText(options['public-key-file']);
      const identity = { handle: machine.handle, machineId: machine.machine_id, runtimeSlot: machine.runtime_slot };
      const envelope = encryptRuntimeTokenRotation({
        machineId: machine.machine_id,
        runtimeSlot: machine.runtime_slot,
        epoch: nextEpoch,
        tokens: {
          sync: buildPlatformSyncVerificationToken(identity, secret, nextEpoch),
          fundedAi: buildPlatformRuntimeVerificationToken(identity, secret, nextEpoch),
          speech: buildPlatformSpeechRuntimeVerificationToken(identity, secret, nextEpoch),
        },
      }, publicKey);
      await writeFile(options.out, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Prepared encrypted runtime token epoch ${nextEpoch}.\n`);
      return;
    }
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
