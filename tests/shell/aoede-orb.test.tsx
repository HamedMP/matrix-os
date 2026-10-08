// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AoedeOrb } from "../../shell/src/aoede/AoedeOrb";

vi.mock("shaders/react", () => ({
  Shader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Nebula: ({ glow, billow }: { glow: number; billow: number }) => <div data-testid="nebula" data-glow={glow} data-billow={billow} />,
}));
const microphone = {} as MediaStream, speaker = {} as MediaStream;
let reduced = false, input = 0, output = 0, frame: FrameRequestCallback | undefined;
let time = 0;
const contexts: { close: ReturnType<typeof vi.fn>; sources: { disconnect: ReturnType<typeof vi.fn> }[] }[] = [];
const inputStream = () => microphone;
function tick() { act(() => { time += 40; frame?.(time); }); }
function props() {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "paused", { value: false, configurable: true });
  audio.srcObject = speaker;
  return { animate: true, muted: false, connecting: false, inputStream, audioRef: { current: audio } };
}
beforeEach(() => {
  reduced = false; input = output = time = 0; contexts.length = 0; frame = undefined;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", class {
    sources: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    close = vi.fn(async () => undefined);
    resume = vi.fn(async () => undefined);
    constructor() { contexts.push(this); }
    createAnalyser() {
      return { fftSize: 256, disconnect: vi.fn(), getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) };
    }
    createMediaStreamSource(stream: MediaStream) {
      const source = { disconnect: vi.fn(), connect: (analyser: ReturnType<this["createAnalyser"]>) => {
        analyser.getFloatTimeDomainData = samples => samples.fill(stream === microphone ? input : output);
      } };
      this.sources.push(source); return source;
    }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("responds to microphone energy in the fallback and releases smoothly back to listening", () => {
  const view = render(<AoedeOrb {...props()} />);
  const orb = view.container.querySelector(".aoede-orb")!;
  tick();
  expect(orb.getAttribute("data-activity")).toBe("listening");
  expect(orb.getAttribute("data-level")).toBe("0.000");
  input = 0.16; tick();
  expect(Number(orb.getAttribute("data-level"))).toBeCloseTo(0.72, 2);
  expect((orb as HTMLElement).style.transform).not.toBe("scale(1)");
  input = 0; tick();
  expect(Number(orb.getAttribute("data-level"))).toBeCloseTo(0.518, 2);
});

it("meters actual assistant audio even when the microphone is muted, but not paused playback", () => {
  const value = props();
  const view = render(<AoedeOrb {...value} muted />);
  const orb = view.container.querySelector(".aoede-orb")!;
  input = 0.25; tick();
  expect(orb.getAttribute("data-activity")).toBe("muted");
  expect(orb.getAttribute("data-level")).toBe("0.000");
  output = 0.09; tick();
  expect(orb.getAttribute("data-activity")).toBe("speaking");
  expect(Number(orb.getAttribute("data-level"))).toBeCloseTo(0.54, 2);
  Object.defineProperty(value.audioRef.current, "paused", { value: true }); tick();
  expect(orb.getAttribute("data-activity")).toBe("muted");
});

it("updates Nebula uniforms from audio without remounting or rebuilding the audio graph", async () => {
  vi.stubGlobal("navigator", { gpu: {} });
  const view = render(<AoedeOrb {...props()} />);
  await waitFor(() => expect(view.getByTestId("nebula")).toBeTruthy());
  const nebula = view.getByTestId("nebula");
  tick(); input = 0.16; tick();
  expect(Number(nebula.getAttribute("data-glow"))).toBeGreaterThan(0.8);
  expect(Number(nebula.getAttribute("data-billow"))).toBeGreaterThan(0.9);
  expect(view.getByTestId("nebula")).toBe(nebula);
  expect(contexts).toHaveLength(1);
});

it("attaches late streams and disconnects its analysers on end without stopping owned media", () => {
  const value = props(); value.audioRef.current.srcObject = null;
  const view = render(<AoedeOrb {...value} />);
  tick(); expect(contexts[0].sources).toHaveLength(1);
  value.audioRef.current.srcObject = speaker; output = 0.09; tick();
  expect(contexts[0].sources).toHaveLength(2);
  view.rerender(<AoedeOrb {...value} animate={false} />);
  expect(contexts[0].sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalled();
  expect(view.container.querySelector(".aoede-orb")?.getAttribute("data-level")).toBe("0.000");
});

it("does not start audio metering or shaders for reduced motion or connecting", () => {
  reduced = true;
  const view = render(<AoedeOrb {...props()} />);
  expect(contexts).toHaveLength(0);
  expect(view.container.querySelector(".aoede-static-orb")).toBeTruthy();
  reduced = false;
  view.rerender(<AoedeOrb {...props()} connecting />);
  expect(contexts).toHaveLength(0);
  expect(view.container.querySelector(".aoede-orb")?.getAttribute("data-activity")).toBe("connecting");
});
