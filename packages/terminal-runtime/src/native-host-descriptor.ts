import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod/v4";
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f]/.test(value));
const value = z.string().max(8192).refine(value => !value.includes("\0"));
// Native tool/account setup belongs to the owner environment. This descriptor does not carry source authority.
const environment = z.object({ PATH: value, HOME: absolute, TERM: value.optional(), COLORTERM: value.optional(), SHELL: absolute.optional(),
  LANG: value.optional(), LC_ALL: value.optional(), TZ: value.optional(), TMPDIR: absolute.optional(), MATRIX_HOME: absolute.optional(), MATRIX_NODE_PREFIX: absolute.optional() }).strict();
export const TerminalHostLaunchSchema = z.object({ command: absolute, args: z.array(value).max(64), cwd: absolute, env: environment, inheritEnv: z.literal(false) }).strict();
export const TerminalHostDescriptorSchema = z.object({ version: z.literal(1), kind: z.literal("terminal-native"), launchId: z.string().regex(/^[a-f0-9]{32}$/),
  generation: z.string().regex(/^gen_[a-f0-9]{64}$/), createdAt: z.iso.datetime(), directory: absolute,
  launch: TerminalHostLaunchSchema, cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(200),
}).strict().refine(value => value.directory.endsWith(`/matrix-terminal-${value.launchId}`) && Buffer.byteLength(value.directory + "/routine.sock") < 104);
export type TerminalHostDescriptor = z.infer<typeof TerminalHostDescriptorSchema>;
export async function readTerminalHostDescriptor(path: string, expectedDigest?: string) {
  const handle = await open(absolute.parse(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error("Terminal launch unavailable");
    const bytes = Buffer.alloc(65537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error("Terminal launch unavailable");
    const input = bytes.subarray(0, bytesRead), digest = createHash("sha256").update(input).digest("hex");
    if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error("Terminal launch mismatch");
    return { descriptor: TerminalHostDescriptorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input))), digest };
  } finally { await handle.close(); }
}
export function terminalHostUnit(launchId: string) {
  return `matrix-terminal-native-${z.string().regex(/^[a-f0-9]{32}$/).parse(launchId)}.service`;
}
