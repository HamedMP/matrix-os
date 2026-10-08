import { AoedeCloseRequestSchema, AoedeSessionResponseSchema } from "@matrix-os/contracts";

export type CaptionEvent = { type: string; delta?: string; start_ms?: number; end_ms?: number };
export type AoedePhase = "microphone" | "mint" | "transport";
export type AoedeFailure = { phase: AoedePhase | "playback"; code: "denied" | "device" | "conflict" | "limited" | "auth" | "unavailable" | "timeout" | "transport" | "playback" };
export class AoedeMediaError extends Error {
  constructor(readonly failure: AoedeFailure) { super("AoedeMediaUnavailable"); }
}
export function classifyAoedeFailure(error: unknown, phase: AoedePhase): AoedeFailure {
  if (error instanceof AoedeMediaError) return error.failure;
  const name = error instanceof Error || error instanceof DOMException ? error.name : "UnknownError";
  if (phase === "microphone") return { phase, code: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "device" };
  return { phase, code: name === "TimeoutError" || name === "AbortError" ? "timeout" : phase === "mint" ? "unavailable" : "transport" };
}
// Native WebRTC only. The platform sideband remains alive for trusted finalization.
export class AoedeMedia {
  sessionId: string | null = null;
  private disposed = false;
  private stream?: MediaStream;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private deadline?: ReturnType<typeof setTimeout>;
  private disconnectDeadline?: ReturnType<typeof setTimeout>;
  private playbackDeadline?: ReturnType<typeof setTimeout>;
  private reconnecting = false;
  private playbackBlocked = false;
  private playbackAttempt = 0;
  private hasStarted = false;
  private muted = false;
  constructor(private options: {
    gatewayUrl: string; audio: HTMLAudioElement; fetchFn?: typeof fetch;
    onEvent: (event: CaptionEvent) => void; onFailure: (failure: AoedeFailure) => void;
    onPhase?: (phase: AoedePhase) => void;
    onReconnecting?: (reconnecting: boolean) => void;
    onPlaybackBlocked?: (blocked: boolean) => void;
  }) {}
  get microphoneStream() { return this.disposed ? undefined : this.stream; }
  setMuted(muted: boolean) {
    if (this.disposed) return;
    this.muted = muted;
    this.stream?.getTracks().forEach((track) => { if (track.kind === "audio") track.enabled = !muted; });
  }
  private current() { if (this.disposed) throw new Error("AoedeInvocationDismissed"); }
  private fail(failure: AoedeFailure) {
    if (this.disposed) return;
    this.close(); this.options.onFailure(failure);
  }
  // Call synchronously from a user gesture; do not mint or change input mute.
  async resumePlayback(): Promise<void> {
    if (this.disposed) return;
    const attempt = ++this.playbackAttempt;
    // Pending and denied attempts share one non-extending inaudible-session cap.
    this.playbackDeadline ??= setTimeout(() => this.fail({ phase: "playback", code: "playback" }), 30_000);
    try {
      await this.options.audio.play();
      if (this.disposed || attempt !== this.playbackAttempt) return;
      clearTimeout(this.playbackDeadline); this.playbackDeadline = undefined;
      if (this.playbackBlocked) { this.playbackBlocked = false; this.options.onPlaybackBlocked?.(false); }
    } catch (error) {
      if (this.disposed || attempt !== this.playbackAttempt) return;
      console.warn("[aoede] Playback unavailable:", error instanceof Error || error instanceof DOMException ? error.name : "UnknownError");
      if ((error instanceof Error || error instanceof DOMException) && error.name === "NotAllowedError") {
        if (!this.playbackBlocked) { this.playbackBlocked = true; this.options.onPlaybackBlocked?.(true); }
      } else this.fail({ phase: "playback", code: "playback" });
    }
  }
  private async endRemote(sessionId: string) {
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.gatewayUrl}/api/aoede/session`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.warn("[aoede] Session closure not confirmed:", response.status);
    } catch (error) { console.warn("[aoede] Session closure unavailable:", error instanceof Error ? error.name : "UnknownError"); }
  }
  async start(resumeSessionId?: string) {
    let phase: AoedePhase = "microphone";
    const setPhase = (next: AoedePhase) => { phase = next; if (!this.disposed) this.options.onPhase?.(next); };
    try {
      this.current(); setPhase("microphone");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); this.current(); }
      this.stream = stream;
      this.setMuted(this.muted);
      setPhase("transport");
      const peer = this.peer = new RTCPeerConnection();
      const channel = this.channel = peer.createDataChannel("oai-events");
      const fail = () => this.fail({ phase: "transport", code: "transport" });
      channel.onclose = fail;
      channel.onerror = fail;
      peer.onconnectionstatechange = () => {
        if (this.disposed) return;
        if (["failed", "closed"].includes(peer.connectionState)) fail();
        else if (peer.connectionState === "disconnected" && !this.reconnecting) {
          this.reconnecting = true; this.options.onReconnecting?.(true);
          this.disconnectDeadline = setTimeout(fail, 10_000);
        } else if (peer.connectionState === "connected" && this.reconnecting) {
          clearTimeout(this.disconnectDeadline); this.disconnectDeadline = undefined;
          this.reconnecting = false; this.options.onReconnecting?.(false);
        }
      };
      stream.getTracks().forEach((track) => {
        track.onended = () => this.fail({ phase: "microphone", code: "device" });
        peer.addTrack(track, stream);
      });
      peer.ontrack = (event) => {
        if (this.disposed) return;
        this.options.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.resumePlayback();
      };
      channel.onmessage = ({ data }) => {
        if (this.disposed || typeof data !== "string" || data.length > 32_768) return;
        try {
          const event = JSON.parse(data) as CaptionEvent;
          if (event && typeof event.type === "string") this.options.onEvent(event);
        } catch (error) { console.warn("[aoede] Ignored invalid provider event:", error instanceof Error ? error.name : "UnknownError"); }
      };
      await peer.setLocalDescription(await peer.createOffer());
      this.current();
      setPhase("mint");
      // Do not abort a dispatched mint on dismiss: consume the bounded response
      // and close its exact session, rather than orphaning a successful mint.
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.gatewayUrl}/api/aoede/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID(), sdp: peer.localDescription?.sdp, ...(resumeSessionId ? { resumeSessionId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new AoedeMediaError({ phase: "mint", code: response.status === 409 ? "conflict" : response.status === 429 ? "limited" : [401, 403].includes(response.status) ? "auth" : response.status === 504 ? "timeout" : "unavailable" });
      setPhase("transport");
      const body: unknown = await response.json();
      // Retain only a validated invocation ID for cleanup, even if the SDP is malformed.
      const owned = AoedeCloseRequestSchema.safeParse({ sessionId: typeof body === "object" && body !== null && "sessionId" in body ? body.sessionId : null });
      if (owned.success) {
        if (this.disposed) { await this.endRemote(owned.data.sessionId); this.current(); }
        this.sessionId = owned.data.sessionId;
      }
      const answer = AoedeSessionResponseSchema.parse(body);
      this.current();
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.current();
      if (!this.hasStarted) this.deadline = setTimeout(() => this.fail({ phase: "transport", code: "timeout" }), 20_000); // session.started must arrive; no automatic retry
      return answer.sessionId;
    } catch (error) {
      const failure = classifyAoedeFailure(error, phase);
      this.fail(failure);
      throw new AoedeMediaError(failure);
    }
  }
  started() { if (!this.disposed) { this.hasStarted = true; clearTimeout(this.deadline); } }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.deadline);
    clearTimeout(this.disconnectDeadline); clearTimeout(this.playbackDeadline);
    this.playbackAttempt += 1;
    if (this.reconnecting) { this.reconnecting = false; this.options.onReconnecting?.(false); }
    if (this.playbackBlocked) { this.playbackBlocked = false; this.options.onPlaybackBlocked?.(false); }
    if (this.channel?.readyState === "open") {
      try { this.channel.send(JSON.stringify({ type: "session.close" })); }
      catch (error) { console.warn("[aoede] Data-channel close unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    }
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.options.audio.pause();
    this.options.audio.srcObject = null;
    if (this.channel) { this.channel.onclose = null; this.channel.onerror = null; this.channel.onmessage = null; this.channel.close(); }
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); }
    if (this.sessionId) void this.endRemote(this.sessionId);
  }
}
