import type { TtsProvider, TtsOptions, TtsResult } from "./base.js";

type CircuitState = { failures: number; openUntil: number };
type UsageCallback = (info: {
  provider: string;
  chars: number;
  cost: number;
}) => void;

function estimateCost(provider: string, chars: number): number {
  switch (provider) {
    case "elevenlabs":
      return chars * 0.0003;
    case "openai":
      return chars * 0.000015;
    case "edge":
      return 0;
    default:
      return 0;
  }
}

export class FallbackTtsChain implements TtsProvider {
  readonly name = "fallback";
  private providers: TtsProvider[];
  private circuits: Map<string, CircuitState> = new Map();
  private timeoutMs: number;
  private threshold: number;
  private resetMs: number;
  private onUsage?: UsageCallback;

  constructor(
    providers: TtsProvider[],
    options?: {
      timeoutMs?: number;
      circuitBreakerThreshold?: number;
      circuitBreakerResetMs?: number;
      onUsage?: UsageCallback;
    },
  ) {
    this.providers = providers;
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.threshold = options?.circuitBreakerThreshold ?? 3;
    this.resetMs = options?.circuitBreakerResetMs ?? 60_000;
    this.onUsage = options?.onUsage;
  }

  isAvailable(): boolean {
    return this.providers.some((p) => p.isAvailable());
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    if (!text) throw new Error("Text is required for TTS");

    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;

      const circuit = this.circuits.get(provider.name);
      if (circuit && circuit.openUntil > Date.now()) continue;

      try {
        let timer: ReturnType<typeof setTimeout>;
        let result: TtsResult;
        try {
          result = await Promise.race([
            provider.synthesize(text, options),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Timeout")), this.timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }

        this.circuits.delete(provider.name);
        this.onUsage?.({
          provider: provider.name,
          chars: text.length,
          cost: estimateCost(provider.name, text.length),
        });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push({ provider: provider.name, error });

        const state = this.circuits.get(provider.name) || {
          failures: 0,
          openUntil: 0,
        };
        state.failures++;
        if (state.failures >= this.threshold) {
          state.openUntil = Date.now() + this.resetMs;
        }
        this.circuits.set(provider.name, state);
      }
    }

    console.error("[tts] All providers failed:", JSON.stringify(errors));
    throw new Error("All TTS providers failed");
  }

  getStatus(): Array<{
    name: string;
    available: boolean;
    circuitOpen: boolean;
  }> {
    const now = Date.now();
    return this.providers.map((p) => {
      const circuit = this.circuits.get(p.name);
      return {
        name: p.name,
        available: p.isAvailable(),
        circuitOpen: circuit ? circuit.openUntil > now : false,
      };
    });
  }
}
