import type { TunnelProvider, TunnelConfig } from "./base.js";

export class CloudflareTunnel implements TunnelProvider {
  readonly name = "cloudflare";

  async start(config: TunnelConfig): Promise<string> {
    const handle = process.env.MATRIX_HANDLE || "dev";
    return `https://${handle}.matrix-os.com`;
  }

  async stop(): Promise<void> {
    // No-op for managed mode (platform owns the tunnel)
  }

  async health(): Promise<boolean> {
    return !!process.env.MATRIX_HANDLE;
  }
}
