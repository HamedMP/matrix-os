"use client";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

type ShaderModule = typeof import("shaders/react");
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

export function AoedeOrb({ animate }: { animate: boolean }) {
  const module = useShaders(animate);
  return module ? <LiveOrb module={module} />
    : <div className="aoede-orb" aria-hidden="true" data-gpu="fallback"><StaticOrb /></div>;
}

// A new canvas owns a new readiness flag after mute/reduced-motion/session changes.
function LiveOrb({ module }: { module: ShaderModule }) {
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const showShader = !unavailable;
  return <div className="aoede-orb" aria-hidden="true" data-gpu={showShader && ready ? "ready" : "fallback"}>
    {(!showShader || !ready) && <StaticOrb />}
    {showShader && <module.Shader disableTelemetry className="aoede-orb-canvas" style={{opacity: ready ? 1 : 0}}
      onReady={() => setReady(true)} onUnavailable={() => setUnavailable(true)}>
      <module.Nebula shape={{ type: "sphere3D", radius: 0.35 }}
        coreColor="#34B275" gasColor="#FF4D68" veilColor="#357AFF" colorSpace="linear"
        cavity={0} density={0.55} glow={0.6} gasScale={0.6} billow={0.8} stars={0.04}
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
