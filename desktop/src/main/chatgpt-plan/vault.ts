import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { SafeStorageLike } from '../auth/credential-store';
const TokenSchema = z.object({
    clientId: z.string().min(1).max(256), subject: z.string().min(1).max(256), email: z.string().max(254).optional(), accessToken: z.string().min(1).max(16384), refreshToken: z.string().min(1).max(16384), idToken: z.string().min(1).max(16384), scopes: z.array(z.string().max(128)).max(32), expiresAt: z.number().positive(), earliestRefreshAt: z.number().nonnegative().optional()
}).strict();
export const PlanAccountSchema = z.object({
    id: z.uuid(), clientId: z.string().min(1).max(256), subject: z.string().min(1).max(256), label: z.string().min(1).max(256), tokens: TokenSchema.nullable()
}).strict();
const GrantSchema = z.object({
    computerId: z.string().max(128), revision: z.number().int().nonnegative(), enabled: z.boolean(), background: z.boolean()
}).strict();
const VaultSchema = z.object({
    version: z.literal(1), ownerId: z.string().min(1).max(256), hostId: z.string().max(128), deviceId: z.string().regex(/^[a-f0-9]{64}$/), devicePublicKey: z.string().max(1024), devicePrivateKey: z.string().max(2048), accounts: z.array(PlanAccountSchema).max(8), activeAccountId: z.uuid().nullable(), grants: z.array(GrantSchema).max(16)
}).strict();
export type PlanVaultRecord = z.infer<typeof VaultSchema>;
export type PlanAccount = z.infer<typeof PlanAccountSchema>;
export type PlanTokens = z.infer<typeof TokenSchema>;
export function createPlanVault(options: {
    dir: string;
    safeStorage: SafeStorageLike & {
        getSelectedStorageBackend?(): string;
    };
}) {
    const file = (ownerId: string) => join(options.dir, `chatgpt-plan-${createHash('sha256').update(ownerId).digest('hex')}.bin`);
    const available = () => {
        if (!options.safeStorage.isEncryptionAvailable() || options.safeStorage.getSelectedStorageBackend?.() === 'basic_text')
            throw new Error('OS credential protection unavailable');
    };
    let lastSweep = 0;
    async function cleanup() {
        if (Date.now() - lastSweep < 60000)
            return;
        lastSweep = Date.now();
        let directory;
        try {
            directory = await opendir(options.dir);
        }
        catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return;
            throw error;
        }
        let scanned = 0;
        for await (const entry of directory) {
            if (++scanned > 256)
                break;
            if (!/^chatgpt-plan-[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/.test(entry.name))
                continue;
            const path = join(options.dir, entry.name);
            let stat;
            try {
                stat = await lstat(path);
            }
            catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    continue;
                throw error;
            }
            if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < Date.now() - 3600000)
                await rm(path, { force: true });
        }
    }
    return {
        cleanup,
        async load(ownerId: string): Promise<PlanVaultRecord> {
            available();
            await cleanup();
            const path = file(ownerId);
            let handle;
            try {
                handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > 256 * 1024)
                    throw new Error('invalid credential file');
                const blob = await handle.readFile();
                const parsed = VaultSchema.parse(JSON.parse(options.safeStorage.decryptString(blob)));
                if (parsed.ownerId !== ownerId)
                    throw new Error('credential owner mismatch');
                return parsed;
            }
            catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                const pair = generateKeyPairSync('ed25519');
                const publicKey = pair.publicKey.export({
                    type: 'spki', format: 'der'
                });
                return {
                    version: 1, ownerId, hostId: `urn:uuid:${randomUUID()}`, deviceId: createHash('sha256').update(publicKey).digest('hex'), devicePublicKey: publicKey.toString('base64url'), devicePrivateKey: pair.privateKey.export({
                        type: 'pkcs8', format: 'pem'
                    }).toString(), accounts: [], activeAccountId: null, grants: []
                };
            }
            finally {
                await handle?.close();
            }
        },
        async save(ownerId: string, record: PlanVaultRecord) {
            available();
            const parsed = VaultSchema.parse(record);
            if (parsed.ownerId !== ownerId)
                throw new Error('credential owner mismatch');
            await mkdir(options.dir, {
                recursive: true, mode: 0o700
            });
            const path = file(ownerId);
            const temp = `${path}.${randomUUID()}.tmp`;
            let handle;
            try {
                handle = await open(temp, 'wx', 0o600);
                await handle.writeFile(options.safeStorage.encryptString(JSON.stringify(parsed)));
                await handle.sync();
                await handle.close();
                handle = undefined;
                await rename(temp, path);
            }
            finally {
                await handle?.close();
                await rm(temp, { force: true });
            }
        },
    };
}
export type PlanVault = ReturnType<typeof createPlanVault>;
