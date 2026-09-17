export interface PrepareSyncHelperOptions {
  sourceDir: string;
  outputDir: string;
  cliVersion: string;
  platform: "darwin" | "linux";
  arch: "x64" | "arm64";
}

export function prepareSyncHelper(options: PrepareSyncHelperOptions): Promise<void>;
export function prepareUnavailableSyncHelper(options: {
  outputDir: string;
  platform: string;
  arch: string;
}): Promise<void>;
