import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { observePlanFailures, safePlanFailureRecord, type PlanFailureRecord } from './diagnostics';

const MAX_ROWS = 128;
const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DRAIN_MS = 1000;
/** Profile identity is used only in the local directory name, never in a record. */
export function planDiagnosticDirectory(logsDirectory: string, userData: string): string {
    return join(logsDirectory, 'chatgpt-plan-' + createHash('sha256').update(userData).digest('hex').slice(0, 16));
}
/** Only this fixed file and its exclusive temporary sibling are ever accessed. */
export function createPlanDiagnosticStore(options: { directory: string; now?: () => number }) {
    const now = options.now ?? Date.now;
    const file = join(options.directory, 'chatgpt-plan-failures.json');
    const temporary = join(options.directory, '.chatgpt-plan-failures.tmp');
    let rows: PlanFailureRecord[] = [];
    let dirty = false, stopped = false, closing = false, warned = false, failed = false, initialized = false;
    let operation: Promise<void> | undefined;
    let closeTask: Promise<boolean> | undefined;
    const warning = () => { if (!warned) { warned = true; console.warn('[chatgpt-plan] diagnostic_write_failed'); } };
    const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
    async function directory() {
        // The parent is Electron's own logs directory. Never follow a replaced
        // logs root or the dedicated profile directory into another location.
        const parent = dirname(options.directory);
        await mkdir(parent, { recursive: true });
        const root = await lstat(parent);
        if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Unsafe diagnostic parent');
        try { await mkdir(options.directory, { mode: 0o700 }); }
        catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
        const entry = await lstat(options.directory);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe diagnostic directory');
        if ((entry.mode & 0o777) !== 0o700) await chmod(options.directory, 0o700);
    }
    function prune() {
        const time = now();
        rows = rows.filter(row => Date.parse(row.observedAt) > time - MAX_AGE_MS && Date.parse(row.observedAt) <= time).slice(-MAX_ROWS);
        while (rows.length && Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) rows.shift();
    }
    async function regular(path: string) {
        try { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Unsafe diagnostic file'); return entry; }
        catch (error: unknown) { if (missing(error)) return null; throw error; }
    }
    async function readSaved(): Promise<PlanFailureRecord[] | undefined> {
        await directory();
        // A single-instance app may leave this exact temporary file after a crash.
        if (await regular(temporary)) await unlink(temporary);
        const entry = await regular(file);
        if (!entry) return;
        if (entry.size > MAX_BYTES) return [];
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const actual = await handle.stat();
            if (!actual.isFile() || actual.nlink !== 1 || actual.size > MAX_BYTES) throw new Error('Unsafe diagnostic file');
            const buffer = Buffer.alloc(MAX_BYTES + 1);
            const read = await handle.read(buffer, 0, buffer.length, 0);
            if (read.bytesRead > MAX_BYTES) throw new Error('Oversized diagnostic file');
            let value: unknown;
            try { value = JSON.parse(buffer.subarray(0, read.bytesRead).toString('utf8')); }
            catch (error: unknown) {
                // Only malformed JSON in this recorder's own regular file is
                // recoverable here. Filesystem/ownership failures stay failures.
                if (!(error instanceof SyntaxError)) throw error;
                warning(); return [];
            }
            return Array.isArray(value) ? value.slice(-MAX_ROWS).flatMap(value => { const row = safePlanFailureRecord(value); return row ? [row] : []; }) : [];
        } finally { await handle.close(); }
    }
    async function initialize() {
        const saved = await readSaved();
        if (saved) { rows = [...saved, ...rows]; prune(); dirty = true; }
        initialized = true;
    }
    const ready = initialize().catch((error: unknown) => { failed = true; warning(); });
    async function persist() {
        await ready;
        // A failed startup read must not permit replacement of unread history.
        // Retry only in the existing serialized writer; a failure retains new
        // rows for a later record/flush/sweep without starting a retry loop.
        if (!initialized) await initialize();
        // Maintenance shares the writer slot, so it cannot delete an active
        // write. Recheck the exact regular, singly linked file before unlinking.
        await directory();
        if (await regular(temporary)) await unlink(temporary);
        while (dirty && !stopped) {
            dirty = false; prune();
            const body = JSON.stringify(rows);
            await directory(); await regular(file);
            const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(body, 'utf8');
                await handle.close();
                if (!stopped) await rename(temporary, file);
            } finally {
                await handle.close().catch((error: unknown) => { warning(); });
                try { await unlink(temporary); } catch (error: unknown) { if (!missing(error)) warning(); }
            }
            warned = false; failed = false;
        }
    }
    function start() {
        if (operation || stopped) return;
        operation = persist().catch((error: unknown) => { dirty = true; failed = true; warning(); }).finally(() => {
            operation = undefined;
            // Keep the snapshot for a later flush/record, without a disk-failure retry loop.
            if (dirty && !failed && !stopped) start();
        });
    }
    void ready.then(() => { if (dirty && !stopped) start(); });
    const unobserve = observePlanFailures(row => {
        if (closing || stopped) return;
        rows.push({ ...row, observedAt: new Date(now()).toISOString() }); prune(); dirty = true; start();
    });
    const timer = setInterval(() => {
        const count = rows.length; prune();
        if (rows.length !== count) dirty = true;
        start();
    }, 60 * 60 * 1000);
    timer.unref();
    async function flush(): Promise<boolean> {
        if (stopped) return false;
        start();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const drain = async () => {
            // A final callback can hand ownership to a coalesced successor.
            // Await that writer too, within the same overall deadline.
            while (!stopped) {
                const current = operation;
                if (current) { await current; if (failed) return false; }
                else if (dirty) start();
                else return !failed;
            }
            return false;
        };
        try {
            return await Promise.race([drain(), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), DRAIN_MS); })]);
        } finally { if (timeout) clearTimeout(timeout); }
    }
    function close(): Promise<boolean> {
        if (closeTask) return closeTask;
        closing = true; unobserve(); clearInterval(timer);
        closeTask = flush().finally(() => { stopped = true; });
        return closeTask;
    }
    return { flush, close };
}
