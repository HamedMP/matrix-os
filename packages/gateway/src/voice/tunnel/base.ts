export interface TunnelProvider {
  readonly name: string;
  start(config: TunnelConfig): Promise<string>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
}

export interface TunnelConfig {
  provider: string;
  localPort: number;
  path?: string;
}
