import { rm } from "node:fs/promises";

interface RecursiveRemoveOptions {
  force: true;
  maxRetries: number;
  recursive: true;
  retryDelay: number;
}

type RemoveDirectory = (
  path: string,
  options: RecursiveRemoveOptions,
) => Promise<void>;

const REMOVE_OPTIONS = {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 50,
} satisfies RecursiveRemoveOptions;

export async function removeTestDirectory(
  path: string,
  remove: RemoveDirectory = rm,
): Promise<void> {
  await remove(path, REMOVE_OPTIONS);
}
