import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { boundedGoogleReviewBytes, GOOGLE_REVIEW_MAX_BYTES, GoogleProcessingReviewError, GoogleReviewFilenameSchema } from './operator-review.js';

function deny(): never { throw new GoogleProcessingReviewError(); }
function privateMode(mode: number, expected: number): boolean { return (mode & 0o7777) === expected; }
function owned(uid: number): boolean { return typeof process.getuid === 'function' && uid === process.getuid(); }
async function generic<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) { if (error instanceof GoogleProcessingReviewError) throw error; throw new GoogleProcessingReviewError(); }
}

/** Flat, private, canonical operator folder. No URL fetches, symlink traversal, shared files, or path-based disclosure. */
export async function createGoogleOperatorEvidenceFiles(directory: string) {
  return generic(async () => {
    if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) deny();
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let closed = false;
    try {
      const root = await directoryHandle.stat();
      if (!root.isDirectory() || !privateMode(root.mode, 0o700) || !owned(root.uid)) deny();
      const checkDirectory = async () => {
        if (closed) deny();
        const current = await lstat(directory);
        if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino
          || !privateMode(current.mode, 0o700) || !owned(current.uid) || await realpath(directory) !== directory) deny();
      };
      const name = (input: string) => GoogleReviewFilenameSchema.parse(input);
      const reserveReceipt = async (input: string) => generic(async () => {
        await checkDirectory();
        const handle = await open(join(directory, name(input)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let receiptClosed = false, writing = false;
        let identity = await handle.stat();
        const assertReceipt = async () => {
          const current = await lstat(join(directory, name(input)));
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
            || !privateMode(current.mode, 0o600) || !owned(current.uid) || current.nlink !== 1) deny();
        };
        try { await checkDirectory(); await assertReceipt(); }
        catch (error: unknown) { await handle.close(); throw error; }
        return {
          write: async (value: unknown) => generic(async () => {
            if (receiptClosed || writing) deny();
            writing = true;
            let temporary: Awaited<ReturnType<typeof open>> | undefined;
            let temporaryIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
            let temporaryPath: string | undefined;
            try {
              await checkDirectory(); await assertReceipt();
              const bytes = boundedGoogleReviewBytes(JSON.stringify(value));
              temporaryPath = join(directory, `receipt-${randomUUID()}.tmp`);
              temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              temporaryIdentity = await temporary.stat();
              let offset = 0;
              while (offset < bytes.byteLength) {
                const result = await temporary.write(bytes, offset, bytes.byteLength - offset, offset);
                if (!result.bytesWritten) deny();
                offset += result.bytesWritten;
              }
              await temporary.sync(); await temporary.close(); temporary = undefined;
              await checkDirectory(); await assertReceipt();
              const currentTemporary = await lstat(temporaryPath);
              if (!currentTemporary.isFile() || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino
                || !privateMode(currentTemporary.mode, 0o600) || !owned(currentTemporary.uid) || currentTemporary.nlink !== 1) deny();
              // The old pending bytes survive all pre-publication write/rename failures.
              // A private operator-owned directory and immediate identity checks bound replacement authority.
              await rename(temporaryPath, join(directory, name(input)));
              identity = temporaryIdentity; temporaryPath = undefined;
              await directoryHandle.sync(); await checkDirectory(); await assertReceipt();
            } finally {
              try { await temporary?.close(); }
              finally {
                if (temporaryPath && temporaryIdentity) {
                  const leftover = await lstat(temporaryPath).catch((error: unknown) => {
                    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
                    throw error;
                  });
                  if (leftover?.isFile() && leftover.dev === temporaryIdentity.dev && leftover.ino === temporaryIdentity.ino
                    && owned(leftover.uid) && leftover.nlink === 1) await unlink(temporaryPath);
                }
                writing = false;
              }
            }
          }),
          close: async () => { if (!receiptClosed) { receiptClosed = true; await handle.close(); } },
        };
      });
      return {
        readArtifact: async (input: string) => generic(async () => {
          await checkDirectory();
          const handle = await open(join(directory, name(input)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || !privateMode(stat.mode, 0o600) || !owned(stat.uid) || stat.nlink !== 1 || stat.size > GOOGLE_REVIEW_MAX_BYTES) deny();
            const buffer = Buffer.alloc(GOOGLE_REVIEW_MAX_BYTES + 1);
            let offset = 0;
            while (offset < buffer.length) {
              const result = await handle.read(buffer, offset, buffer.length - offset, offset);
              if (!result.bytesRead) break;
              offset += result.bytesRead;
            }
            await checkDirectory();
            return Buffer.from(boundedGoogleReviewBytes(buffer.subarray(0, offset)));
          } finally { await handle.close(); }
        }),
        reserveReceipt,
        writeReceipt: async (input: string, value: unknown) => {
          const receipt = await reserveReceipt(input);
          try { await receipt.write(value); } finally { await receipt.close(); }
        },
        close: async () => { if (!closed) { closed = true; await directoryHandle.close(); } },
      };
    } catch (error: unknown) { await directoryHandle.close(); throw error; }
  });
}
