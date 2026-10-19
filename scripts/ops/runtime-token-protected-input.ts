/** Bounded operator-owned inputs; pin ancestors and reject symlink/rebinding races. */
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function readProtectedOperatorInput(path: string): Promise<string> {
  const target = resolve(path);
  const parents: Array<{ path: string; dev: number; ino: number; mode: number; uid: number; gid: number }> = [];
  for (let parent = dirname(target); ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    const owner = stat.uid === 0 || stat.uid === process.getuid?.();
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owner || ((stat.mode & 0o022) && !stickyRoot)) {
      throw new Error('Unsafe operator input ancestor');
    }
    parents.push({ path: parent, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid });
    if (parent === dirname(parent)) break;
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 65_536 || (before.mode & 0o777) !== 0o600
      || (before.uid !== 0 && before.uid !== process.getuid?.())) throw new Error('Unsafe operator input file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await file.stat(); const current = await lstat(target);
    if (length !== before.size || !current.isFile() || current.nlink !== 1 || before.mode !== current.mode
      || before.uid !== current.uid || before.gid !== current.gid || before.ctimeMs !== current.ctimeMs
      || before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Operator input changed');
    }
    for (const parent of parents) {
      const observed = await lstat(parent.path);
      if (!observed.isDirectory() || observed.dev !== parent.dev || observed.ino !== parent.ino
        || observed.mode !== parent.mode || observed.uid !== parent.uid || observed.gid !== parent.gid) throw new Error('Operator input ancestor changed');
    }
    return bytes.subarray(0, length).toString('utf8');
  } finally { await file.close(); }
}

/** JSON.parse discards duplicate keys; reject them before using operator bindings. */
export function parseUniqueOperatorJson(text: string): unknown {
  if (Buffer.byteLength(text) > 65_536) throw new Error('Oversized operator input');
  const parsed: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  let keys = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{' || char === '[') {
      if (stack.length >= 128) throw new Error('Operator input nesting limit');
      stack.push(char === '{' ? new Set() : null);
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index++;
      for (; index < text.length; index += 1) {
        if (text[index] === '\\') index += 1;
        else if (text[index] === '"') break;
      }
      let following = index + 1;
      while (/\s/.test(text[following] ?? '') && following < text.length) following += 1;
      if (text[following] === ':') {
        const key: string = JSON.parse(text.slice(start, index + 1));
        const scope = stack.at(-1);
        if (!scope || scope.has(key) || ++keys > 4096) throw new Error('Duplicate operator input key');
        scope.add(key);
      }
    }
  }
  return parsed;
}
