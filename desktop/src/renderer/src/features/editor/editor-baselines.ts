import type { OpenedFile } from "./editor-save";

const FILE_BASELINE_CAP = 64;
const fileBaselines = new Map<string, OpenedFile>();

export function getFileBaseline(key: string): OpenedFile | undefined {
  const baseline = fileBaselines.get(key);
  if (!baseline) return undefined;
  fileBaselines.delete(key);
  fileBaselines.set(key, baseline);
  return baseline;
}

export function rememberFileBaseline(key: string, file: OpenedFile): void {
  fileBaselines.delete(key);
  fileBaselines.set(key, file);
  while (fileBaselines.size > FILE_BASELINE_CAP) {
    const oldest = fileBaselines.keys().next();
    if (oldest.done) break;
    fileBaselines.delete(oldest.value);
  }
}

export function clearFileBaselinesForTest(): void {
  fileBaselines.clear();
}
