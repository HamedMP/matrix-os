import { writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Named wrapper-only backpressure fault. No native/process identity or source proof is fabricated. */
export async function managedLaunchOverflow(home: string) {
  const marker = join(home, "wrapper-overflow"), preload = join(home, "named-wrapper-overflow.mjs");
  await writeFile(preload, `import { Socket } from 'node:net'; import { Writable } from 'node:stream'; import { existsSync } from 'node:fs'; const get = Object.getOwnPropertyDescriptor(Writable.prototype, 'writableLength').get; Object.defineProperty(Socket.prototype, 'writableLength', { configurable: true, get() { return existsSync(${JSON.stringify(marker)}) ? 393217 : get.call(this); } });\n`);
  return { preload, async trigger() { await writeFile(marker, "overflow"); } };
}
