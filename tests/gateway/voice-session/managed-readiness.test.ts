/**
 * Managed Platform-Speech readiness probe + fail-closed capability gate.
 *
 * The "managed" voice adapter is the only production speech authority, and an
 * adapter's mere registration is not readiness: this suite pins the bounded,
 * single-flight, asymmetric-TTL probe (`createManagedVoiceReadinessProbe`) and
 * the capability gate (`wrapCapabilityPortWithReadiness`) that flattens the
 * advertised VoiceCapability whenever managed speech is not "ready".
 */
import { describe, expect, it, vi } from "vitest";
import type { VoiceCapability } from "@matrix-os/contracts/voice-session";
import {
  createManagedVoiceReadinessProbe,
  MANAGED_VOICE_ADAPTER_ID,
  unavailableManagedVoiceCapability,
  wrapCapabilityPortWithReadiness,
} from "../../../packages/gateway/src/speech/managed-readiness.js";
import { FakeClock } from "./fakes.js";

/** Schema-valid platform speech capability payload with streaming synthesis. */
const readySpeech = {
  contractVersion: 1 as const,
  fileTranscription: {
    status: "ready" as const,
    dictation: {
      enabled: true as const,
      maxBytes: 1024,
      maxDurationMs: 1_000,
      maxTranscriptChars: 100,
      supportedMediaTypes: ["audio/wav" as const],
      languageHints: false,
    },
    ownerAudio: { enabled: false as const },
  },
  synthesis: {
    status: "ready" as const,
    maxInputChars: 4_096,
    format: "pcm_s16le_24000_mono" as const,
    streaming: true,
  },
};

const streamingMissing = {
  status: "ready" as const,
  maxInputChars: 4_096,
  format: "pcm_s16le_24000_mono" as const,
};

const availableCapability: VoiceCapability = {
  contractVersion: 1,
  status: "available",
  surface: "web_desktop",
  transportModes: ["relayed_websocket"],
  turnModes: ["hands_free", "push_to_talk"],
  supportsInterruption: true,
  resume: "delivery_aware",
  sessionOnly: "unsupported",
  actionMode: "conversation_only",
  actionCancellation: "none",
  supportsInputSelection: true,
  supportsOutputSelection: true,
};

function speechClient(impl: (signal?: AbortSignal) => Promise<unknown>) {
  return { capabilities: vi.fn(impl) };
}

/** Probe rig on the shared FakeClock: `now` and `sleep` are fully manual. */
function rig(
  client: { capabilities: (signal?: AbortSignal) => Promise<unknown> },
  options: { ttlMs?: number; negativeTtlMs?: number; timeoutMs?: number; synthesisSource?: "platform" | "external" } = {},
) {
  const clock = new FakeClock();
  const probe = createManagedVoiceReadinessProbe({
    client: client as never,
    now: () => clock.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => {
      clock.after(ms, resolve);
    }),
    ...options,
  });
  return { clock, probe };
}

function capabilityPort(capability: VoiceCapability) {
  return { capabilities: vi.fn(async () => capability) };
}

describe("createManagedVoiceReadinessProbe", () => {
  it("reports ready only when transcription is ready and synthesis streams", async () => {
    const client = speechClient(async () => readySpeech);
    const { clock, probe } = rig(client);
    const result = await probe.probe();
    expect(result).toEqual({ state: "ready", checkedAt: clock.now() });
    expect(client.capabilities).toHaveBeenCalledTimes(1);
  });

  it("reports unready when a capability leg is not ready or cannot stream", async () => {
    const legs = [
      // Transcription leg unavailable (funded platform authority says so).
      {
        ...readySpeech,
        fileTranscription: {
          status: "unavailable" as const,
          reason: "funding_unavailable" as const,
          dictation: readySpeech.fileTranscription.dictation,
          ownerAudio: readySpeech.fileTranscription.ownerAudio,
        },
      },
      // Synthesis leg unavailable.
      { ...readySpeech, synthesis: { status: "unavailable" as const, reason: "temporarily_unavailable" as const } },
      // No synthesis leg at all.
      { contractVersion: 1 as const, fileTranscription: readySpeech.fileTranscription },
      // Ready-but-completed-only synthesis is not Aoede readiness.
      { ...readySpeech, synthesis: streamingMissing },
      { ...readySpeech, synthesis: { ...streamingMissing, streaming: false } },
    ];
    for (const payload of legs) {
      const { probe } = rig(speechClient(async () => payload));
      await expect(probe.probe()).resolves.toMatchObject({ state: "unready" });
    }
  });

  it("skips the platform synthesis leg when a dev-gated port owns synthesis", async () => {
    // The registered adapter still uses platform STT, so transcription keeps
    // gating — but an absent/non-streaming platform synthesis is not this
    // adapter's authority and must not fail it closed.
    const noSynthesis = { contractVersion: 1 as const, fileTranscription: readySpeech.fileTranscription };
    const { probe } = rig(speechClient(async () => noSynthesis), { synthesisSource: "external" });
    await expect(probe.probe()).resolves.toMatchObject({ state: "ready" });

    const sttDown = {
      contractVersion: 1 as const,
      fileTranscription: {
        status: "unavailable" as const,
        reason: "funding_unavailable" as const,
        dictation: readySpeech.fileTranscription.dictation,
        ownerAudio: readySpeech.fileTranscription.ownerAudio,
      },
    };
    const { probe: gatedProbe } = rig(speechClient(async () => sttDown), { synthesisSource: "external" });
    await expect(gatedProbe.probe()).resolves.toMatchObject({ state: "unready" });
  });

  it("reports timeout when the capability call never resolves", async () => {
    const client = speechClient(async () => new Promise(() => undefined));
    const { clock, probe } = rig(client, { timeoutMs: 1_000 });
    const pending = probe.probe();
    clock.advance(1_000);
    await expect(pending).resolves.toEqual({ state: "timeout", checkedAt: 1_000 });
  });

  it("still bounds the probe when only real timers can fire", async () => {
    const client = speechClient(async () => new Promise(() => undefined));
    // No injected sleep wins here: the internal AbortSignal.timeout bound is
    // the backstop even for a dependency that ignores the signal.
    const probe = createManagedVoiceReadinessProbe({
      client: client as never,
      timeoutMs: 1_000,
    });
    await expect(probe.probe()).resolves.toMatchObject({ state: "timeout" });
  }, 5_000);

  it("reports unknown on transport errors and malformed payloads", async () => {
    const thrown = rig(speechClient(async () => {
      throw new Error("socket reset");
    }));
    await expect(thrown.probe.probe()).resolves.toMatchObject({ state: "unknown" });

    const malformed = rig(speechClient(async () => ({ definitely: "not a capability doc" })));
    await expect(malformed.probe.probe()).resolves.toMatchObject({ state: "unknown" });
  });

  it("caches a ready result for the full TTL without re-calling the client", async () => {
    const client = speechClient(async () => readySpeech);
    const { clock, probe } = rig(client);
    await probe.probe();
    clock.set(29_999);
    await probe.probe();
    expect(client.capabilities).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the positive TTL expires", async () => {
    const client = speechClient(async () => readySpeech);
    const { clock, probe } = rig(client);
    await probe.probe();
    clock.set(30_001);
    await probe.probe();
    expect(client.capabilities).toHaveBeenCalledTimes(2);
  });

  it("caches non-ready states for the shorter negative TTL", async () => {
    let payload: unknown = {
      ...readySpeech,
      synthesis: { status: "unavailable" as const, reason: "temporarily_unavailable" as const },
    };
    const client = speechClient(async () => payload);
    const { clock, probe } = rig(client);

    await expect(probe.probe()).resolves.toMatchObject({ state: "unready" });
    payload = readySpeech;

    // Within the 5s negative TTL the failed answer is served from cache —
    // bounded hammering — then recovery is picked up quickly.
    clock.set(4_999);
    await expect(probe.probe()).resolves.toMatchObject({ state: "unready" });
    expect(client.capabilities).toHaveBeenCalledTimes(1);

    clock.set(5_001);
    await expect(probe.probe()).resolves.toMatchObject({ state: "ready" });
    expect(client.capabilities).toHaveBeenCalledTimes(2);

    // The fresh ready result re-arms the full positive TTL.
    clock.set(35_000);
    await expect(probe.probe()).resolves.toMatchObject({ state: "ready" });
    expect(client.capabilities).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe across concurrent callers", async () => {
    const gate = Promise.withResolvers<unknown>();
    const client = speechClient(() => gate.promise);
    const { probe } = rig(client);

    const first = probe.probe();
    const second = probe.probe();
    const third = probe.probe();
    expect(client.capabilities).toHaveBeenCalledTimes(1);

    gate.resolve(readySpeech);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toMatchObject({ state: "ready" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(client.capabilities).toHaveBeenCalledTimes(1);
  });

  it("invalidate() drops the cached answer so the next probe re-calls", async () => {
    const client = speechClient(async () => readySpeech);
    const { probe } = rig(client);
    await probe.probe();
    probe.invalidate();
    await probe.probe();
    expect(client.capabilities).toHaveBeenCalledTimes(2);
  });

  it("clamps an over-large timeout instead of hanging unbounded", async () => {
    const client = speechClient(async () => new Promise(() => undefined));
    const { clock, probe } = rig(client, { timeoutMs: 60_000 });
    const pending = probe.probe();
    clock.advance(15_000);
    await expect(pending).resolves.toMatchObject({ state: "timeout" });
  });
});

describe("unavailableManagedVoiceCapability", () => {
  it("flattens advertised capability to a schema-valid fail-closed shape", () => {
    const flattened = unavailableManagedVoiceCapability(availableCapability);
    expect(flattened).toMatchObject({
      status: "unavailable",
      transportModes: [],
      turnModes: [],
      supportsInterruption: false,
      resume: "unsupported",
      sessionOnly: "unsupported",
      actionMode: "conversation_only",
      actionCancellation: "none",
      supportsInputSelection: false,
      supportsOutputSelection: false,
      reason: "provider_unavailable",
      surface: "web_desktop",
      contractVersion: 1,
    });
  });
});

describe("wrapCapabilityPortWithReadiness", () => {
  const input = { principalId: "user_1", chatId: "chat_1" };

  function gate(options: {
    capability?: VoiceCapability;
    probe: { probe(): Promise<{ state: "ready" | "unready" | "timeout" | "unknown"; checkedAt: number }> };
    selectedAdapterId?: () => string | undefined;
  }) {
    return wrapCapabilityPortWithReadiness({
      port: capabilityPort(options.capability ?? availableCapability),
      probe: options.probe,
      ...(options.selectedAdapterId ? { selectedAdapterId: options.selectedAdapterId } : {}),
    });
  }

  it("passes capability through when the managed probe is ready", async () => {
    const probe = { probe: vi.fn(async () => ({ state: "ready" as const, checkedAt: 0 })) };
    const port = gate({ probe, selectedAdapterId: () => MANAGED_VOICE_ADAPTER_ID });
    expect(await port.capabilities(input)).toEqual(availableCapability);
    expect(probe.probe).toHaveBeenCalledTimes(1);
  });

  it("flattens capability for every non-ready managed probe state", async () => {
    for (const state of ["unready", "timeout", "unknown"] as const) {
      const probe = { probe: vi.fn(async () => ({ state, checkedAt: 0 })) };
      const port = gate({ probe, selectedAdapterId: () => MANAGED_VOICE_ADAPTER_ID });
      const capability = await port.capabilities(input);
      expect(capability).toMatchObject({
        status: "unavailable",
        transportModes: [],
        turnModes: [],
        reason: "provider_unavailable",
        actionMode: "conversation_only",
      });
    }
  });

  it("fails closed when the probe itself throws", async () => {
    const probe = {
      probe: vi.fn(async () => {
        throw new Error("probe blew up");
      }),
    };
    const port = gate({ probe, selectedAdapterId: () => MANAGED_VOICE_ADAPTER_ID });
    expect(await port.capabilities(input)).toMatchObject({ status: "unavailable" });
  });

  it("never consults the probe for non-managed adapters", async () => {
    for (const adapterId of ["simulator", "openai", undefined]) {
      const probe = { probe: vi.fn(async () => ({ state: "timeout" as const, checkedAt: 0 })) };
      const port = gate({ probe, selectedAdapterId: () => adapterId });
      expect(await port.capabilities(input)).toEqual(availableCapability);
      expect(probe.probe).not.toHaveBeenCalled();
    }
  });

  it("never consults the probe when capability is already unavailable", async () => {
    const probe = { probe: vi.fn(async () => ({ state: "ready" as const, checkedAt: 0 })) };
    const unavailable: VoiceCapability = {
      ...availableCapability,
      status: "unavailable",
      transportModes: [],
      turnModes: [],
      supportsInterruption: false,
      resume: "unsupported",
      supportsInputSelection: false,
      supportsOutputSelection: false,
      reason: "not_configured",
    };
    const port = gate({ capability: unavailable, probe, selectedAdapterId: () => MANAGED_VOICE_ADAPTER_ID });
    expect(await port.capabilities(input)).toEqual(unavailable);
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it("defaults to gating when no adapter selector is supplied", async () => {
    const probe = { probe: vi.fn(async () => ({ state: "unready" as const, checkedAt: 0 })) };
    const port = gate({ probe });
    expect(await port.capabilities(input)).toMatchObject({ status: "unavailable" });
    expect(probe.probe).toHaveBeenCalledTimes(1);
  });
});
