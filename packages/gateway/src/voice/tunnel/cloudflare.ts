import type { TunnelProvider, TunnelConfig } from "./base.js";

export class CloudflareTunnel implements TunnelProvider {
  readonly name = "cloudflare";

  async start(_config: TunnelConfig): Promise<string> {
    return process.env.MATRIX_PUBLIC_APP_URL || "https://app.matrix-os.com";
  }

  async stop(): Promise<void> {
    // No-op for managed mode (platform owns the tunnel)
  }

  async health(): Promise<boolean> {
    return true;
  }
}
