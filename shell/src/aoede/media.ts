import { AoedeSessionResponseSchema } from "@matrix-os/contracts";

export type CaptionEvent = { type: string; delta?: string; start_ms?: number; end_ms?: number };
// Native WebRTC only. The platform sideband remains alive for trusted finalization.
export class AoedeMedia {
  sessionId: string | null = null;
  private disposed = false;
  private stream?: MediaStream;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private deadline?: ReturnType<typeof setTimeout>;
  private hasStarted = false;
  constructor(private options: {
    gatewayUrl: string; audio: HTMLAudioElement; fetchFn?: typeof fetch;
    onEvent: (event: CaptionEvent) => void; onFailure: () => void;
  }) {}
  private current() { if (this.disposed) throw new Error("AoedeInvocationDismissed"); }
  private async endRemote(sessionId: string) {
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.gatewayUrl}/api/aoede/session`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.warn("[aoede] Session closure not confirmed:", response.status);
    } catch (error) { console.warn("[aoede] Session closure unavailable:", error instanceof Error ? error.name : "UnknownError"); }
  }
  async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); this.current(); }
      this.stream = stream;
      const peer = this.peer = new RTCPeerConnection();
      const channel = this.channel = peer.createDataChannel("oai-events");
      const fail = () => { if (!this.disposed) { this.close(); this.options.onFailure(); } };
      channel.onclose = fail;
      channel.onerror = fail;
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) fail();
      };
      stream.getTracks().forEach((track) => {
        track.onended = fail;
        peer.addTrack(track, stream);
      });
      peer.ontrack = (event) => {
        if (this.disposed) return;
        this.options.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.options.audio.play().catch((error: unknown) => {
          console.warn("[aoede] Playback unavailable:", error instanceof Error ? error.name : "UnknownError"); fail();
        });
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
      // Do not abort a dispatched mint on dismiss: consume the bounded response
      // and close its exact session, rather than orphaning a successful mint.
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.gatewayUrl}/api/aoede/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID(), sdp: peer.localDescription?.sdp }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("AoedeSessionUnavailable");
      const answer = AoedeSessionResponseSchema.parse(await response.json());
      if (this.disposed) { await this.endRemote(answer.sessionId); this.current(); }
      this.sessionId = answer.sessionId;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.current();
      if (!this.hasStarted) this.deadline = setTimeout(fail, 20_000); // session.started must arrive; no automatic retry
      return answer.sessionId;
    } catch (error) { this.close(); throw error; }
  }
  started() { this.hasStarted = true; clearTimeout(this.deadline); }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.deadline);
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
