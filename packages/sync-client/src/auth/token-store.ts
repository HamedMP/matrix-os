import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";

export const AuthDataSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().nonnegative(),
  userId: z.string().min(1),
  handle: z.string().min(1),
});

export type AuthData = z.infer<typeof AuthDataSchema>;

function authFilePath(): string {
  return join(homedir(), ".matrixos", "auth.json");
}

export async function loadAuth(path?: string): Promise<AuthData | null> {
  const filePath = path ?? authFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return AuthDataSchema.parse(parsed);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function saveAuth(
  data: AuthData,
  path?: string,
): Promise<void> {
  const filePath = path ?? authFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function clearAuth(path?: string): Promise<void> {
  const filePath = path ?? authFilePath();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

export function isExpired(auth: AuthData): boolean {
  return Date.now() >= auth.expiresAt;
}
