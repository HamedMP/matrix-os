import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { dirname } from "node:path";

export async function resetVolatilePtySessionList(persistPath: string): Promise<void> {
  await mkdirAsync(dirname(persistPath), { recursive: true });
  await writeFileAsync(persistPath, "[]\n");
}
