"use client";
import { useEffect, useId, useState, useSyncExternalStore, type RefObject } from "react";

type ShaderModule = typeof import("shaders/react");
type OrbProps = { animate: boolean; connecting: boolean; muted: boolean;
  inputStream: () => MediaStream | undefined | null; audioRef: RefObject<HTMLAudioElement | null> };
const motionQuery = "(prefers-reduced-motion: reduce)";
const loadShaders = () => import("shaders/react");
function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function reducedMotion() { return window.matchMedia(motionQuery).matches; }
function useShaders(animate: boolean) {
  const reduced = useSyncExternalStore(subscribeMotion, reducedMotion, () => true);
  const [module, setModule] = useState<ShaderModule | null>(null);
  useEffect(() => {
    if (!animate || reduced || !("gpu" in navigator)) return;
    let cancelled = false;
    void loadShaders().then(value => { if (!cancelled) setModule(value); }).catch((error: unknown) => {
      console.warn("[aoede] Shader loading unavailable:", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { cancelled = true; };
  }, [animate, reduced]);
  return animate && !reduced ? module : null;
}

function useOrbAudio({ animate, connecting, muted, inputStream, audioRef }: OrbProps, reduced: boolean) {
  const [signal, setSignal] = useState({ level: 0, speaking: false });
  const active = animate && !connecting && !reduced;
  useEffect(() => {
    if (!active || typeof AudioContext === "undefined") return;
    let context: AudioContext;
    try { context = new AudioContext(); }
    catch (error) {
      console.warn("[aoede] Orb metering unavailable:", error instanceof Error ? error.name : "UnknownError");
      return;
    }
    type Meter = { stream: MediaStream; source: MediaStreamAudioSourceNode; analyser: AnalyserNode };
    // At most two taps. Never connect to the destination or stop the session's tracks.
    const meters: (Meter | undefined)[] = [undefined, undefined];
    const samples = new Float32Array(256);
    const measure = (index: number, stream: MediaStream | undefined | null) => {
      let meter = meters[index];
      if (meter?.stream !== stream) {
        meter?.source.disconnect(); meter?.analyser.disconnect(); meters[index] = undefined;
        if (stream) {
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser(); analyser.fftSize = samples.length;
          meters[index] = meter = { stream, source, analyser }; source.connect(analyser);
        } else meter = undefined;
      }
      if (!meter) return 0;
      meter.analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      return rms < 0.001 ? 0 : Math.min(1, Math.sqrt(rms) * 1.8);
    };
    let frame = 0, previous = 0, lastSample = 0;
    const update = (time: number) => {
      if (time - lastSample >= 40) {
        lastSample = time;
        try {
          const input = measure(0, muted ? null : inputStream());
          const audio = audioRef.current;
          const output = measure(1, audio && !audio.paused ? audio.srcObject as MediaStream | null : null);
          const target = output > 0 ? output : input;
          previous = target >= previous ? target : previous * .72 + target * .28;
          const level = Math.round(previous * 1000) / 1000, speaking = output > 0;
          setSignal(old => old.level === level && old.speaking === speaking ? old : { level, speaking });
        } catch (error) {
          console.warn("[aoede] Orb metering unavailable:", error instanceof Error ? error.name : "UnknownError");
          return; // A visualization failure must not interrupt voice or spam retries.
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    void context.resume().catch((error: unknown) => {
      console.warn("[aoede] Orb metering unavailable:", error instanceof Error ? error.name : "UnknownError");
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const meter of meters) { meter?.source.disconnect(); meter?.analyser.disconnect(); }
      void context.close().catch((error: unknown) => {
        console.warn("[aoede] Orb metering cleanup unavailable:", error instanceof Error ? error.name : "UnknownError");
      });
    };
  }, [active, muted, inputStream, audioRef]);
  return active ? signal : { level: 0, speaking: false };
}

function StaticOrb() {
  const id = useId();
  return <svg viewBox="0 0 320 320" className="aoede-static-orb" aria-hidden="true">
    <defs><linearGradient id={id}>
      {["#34B275", "#FF4D68", "#357AFF", "#C5D6E2"].map((color, i) => <stop key={color} offset={`${i / 3 * 100}%`} stopColor={color} />)}
    </linearGradient></defs>
    {[0, 35, 70, 105, 140].map(angle => <ellipse key={angle} cx="160" cy="160" rx="108" ry="63"
      transform={`rotate(${angle} 160 160)`} fill="none" stroke={`url(#${id})`} strokeWidth="3" opacity=".85" />)}
  </svg>;
}

export function AoedeOrb(props: OrbProps) {
  const reduced = useSyncExternalStore(subscribeMotion, reducedMotion, () => true);
  const module = useShaders(props.animate);
  const { level, speaking } = useOrbAudio(props, reduced);
  const activity = !props.animate ? "idle" : props.connecting ? "connecting"
    : speaking ? "speaking" : props.muted ? "muted" : "listening";
  return <div className="aoede-orb" aria-hidden="true" data-activity={activity} data-level={level.toFixed(3)}
    style={{ transform: `scale(${1 + level * .12})` }}>
    {module ? <LiveOrb module={module} level={level} /> : <StaticOrb />}
  </div>;
}

// Audio updates and mute keep the canvas mounted; a new canvas owns new readiness.
function LiveOrb({ module, level }: { module: ShaderModule; level: number }) {
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const showShader = !unavailable;
  return <div data-gpu={showShader && ready ? "ready" : "fallback"}>
    {(!showShader || !ready) && <StaticOrb />}
    {showShader && <module.Shader disableTelemetry className="aoede-orb-canvas" style={{opacity: ready ? 1 : 0}}
      onReady={() => setReady(true)} onUnavailable={() => setUnavailable(true)}>
      <module.Nebula shape={{ type: "sphere3D", radius: 0.35 }}
        coreColor="#34B275" gasColor="#FF4D68" veilColor="#357AFF" colorSpace="linear"
        cavity={0} density={0.55} glow={0.6 + level * .35} gasScale={0.6} billow={0.8 + level * .2} stars={0.04}
        environment={0.15} highlight={0.2} dust={0.15} scale={1.3} speed={0.22} />
    </module.Shader>}
  </div>;
}

export function AoedeSurface({ animate }: { animate: boolean }) {
  const module = useShaders(animate);
  const [unavailable, setUnavailable] = useState(false);
  return <div className="aoede-surface" aria-hidden="true">
    {module && !unavailable && <module.Shader disableTelemetry className="aoede-surface-canvas" onUnavailable={() => setUnavailable(true)}>
      <module.MeshGradient stops={[{position: 0, color: "#0D0C0C"}, {position: 1 / 3, color: "#193143"},
        {position: 2 / 3, color: "#0E3422"}, {position: 1, color: "#442118"}]} speed={0.12} swirl={0.2} drift={0.3} smoothness={3} />
    </module.Shader>}
  </div>;
}
