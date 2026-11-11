export interface HerdrCoreManifest {
  version: string;
  license?: string;
  source?: string;
  targets: Record<string, { url: string; sha256: string }>;
}

export function readHerdrCoreManifest(path?: string): Promise<HerdrCoreManifest>;
export function herdrCoreTarget(manifest: HerdrCoreManifest, platform: string, arch: string): { url: string; sha256: string };
export function fetchHerdrCore(input: {
  platform: string;
  arch: string;
  outDir: string;
  manifest?: HerdrCoreManifest;
  fetchImpl?: typeof fetch;
  maxArchiveBytes?: number;
}): Promise<string>;
