import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Check, Copy, Download, PhoneOff, Play, Send, Trash2, Upload } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import {
  ICE_CONFIG, MAX_STROKES, MAX_TRANSFER_BYTES, createTransferProtocol,
  parseSignal, serializeSignal, validateStroke, waitForIceGathering,
} from "../lib/collaboration.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

type Received = { name: string; blob: Blob; size: number };
type Stroke = { color: string; width: number; points: number[][] };
type Protocol = ReturnType<typeof createTransferProtocol>;

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, canvas: HTMLCanvasElement) {
  const points = stroke.points;
  context.beginPath();
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width * 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.moveTo(points[0][0] * canvas.width, points[0][1] * canvas.height);
  for (const [x, y] of points.slice(1)) context.lineTo(x * canvas.width, y * canvas.height);
  context.stroke();
}

export function CollaborationWorkspace({ slug }: { slug: string }) {
  const video = slug === "video-call";
  const sharing = slug === "file-share";
  const board = slug === "whiteboard";
  const [localCode, setLocalCode] = useState("");
  const [remoteCode, setRemoteCode] = useState("");
  const [role, setRole] = useState<"host" | "guest" | null>(null);
  const [status, setStatus] = useState("Ready to connect");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mediaOn, setMediaOn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sentPercent, setSentPercent] = useState(0);
  const [receivedPercent, setReceivedPercent] = useState(0);
  const [received, setReceived] = useState<Received | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [ink, setInk] = useState("#d45a3a");
  const [inkWidth, setInkWidth] = useState(4);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const protocolRef = useRef<Protocol | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<Stroke | null>(null);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!received) { setDownloadUrl(""); return; }
    const url = URL.createObjectURL(received.blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [received]);
  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) drawStroke(context, stroke, canvas);
  }, [strokes]);
  useEffect(() => { mountedRef.current = true; return () => {
    mountedRef.current = false;
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    protocolRef.current?.dispose(); channelRef.current?.close(); peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
  }; }, []);

  function disconnect(stopMedia = true) {
    if (connectionTimerRef.current) { clearTimeout(connectionTimerRef.current); connectionTimerRef.current = null; }
    protocolRef.current?.dispose(); protocolRef.current = null;
    channelRef.current?.close(); channelRef.current = null;
    peerRef.current?.close(); peerRef.current = null;
    remoteStreamRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (stopMedia) {
      streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      setMediaOn(false);
    }
    setConnected(false); setLocalCode(""); setRemoteCode(""); setRole(null);
    setStrokes([]); setStatus("Disconnected");
  }

  async function ensureMedia() {
    if (streamRef.current) return streamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use camera and microphone here. Try a current browser over HTTPS.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); throw new Error("Video setup was cancelled."); }
      streamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setMediaOn(true);
      return stream;
    } catch (cause) {
      if (cause instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(cause.name)) throw new Error("Allow camera and microphone access to start a video call.");
      throw new Error("Could not start your camera and microphone. Check your device and browser permissions.");
    }
  }

  function attachChannel(channel: RTCDataChannel) {
    channelRef.current = channel;
    const protocol = createTransferProtocol(channel, {
      onFile: (item: Received) => { setReceived(item); setStatus(`Received ${item.name}`); },
      onProgress: ({ direction, bytes, total }: { direction: string; bytes: number; total: number }) => {
        if (direction === "receive") setReceivedPercent(total ? Math.round(bytes / total * 100) : 100);
      },
      onStroke: (stroke: Stroke) => setStrokes((current) => [...current, stroke].slice(-MAX_STROKES)),
      onClear: () => setStrokes([]),
      onError: (cause: Error) => setError(cause.message),
    });
    protocolRef.current = protocol;
    channel.onmessage = (event) => { void protocol.handleMessage(event.data); };
    channel.onopen = () => { setConnected(true); setError(""); setStatus("Connected directly to your peer"); track(slug, "success"); if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current); };
    channel.onclose = () => { setConnected(false); setStatus("Peer disconnected"); protocol.dispose(); };
    channel.onerror = () => { setConnected(false); setError("Peer connection failed. Try making a new invitation."); };
  }

  function startConnectionTimer(peer: RTCPeerConnection) {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = setTimeout(() => {
      if (peerRef.current === peer && peer.connectionState !== "connected") setError("Connection timed out. Create new codes and try another network.");
    }, 45_000);
  }

  function makePeer(host: boolean) {
    if (typeof RTCPeerConnection === "undefined") throw new Error("This browser does not support WebRTC.");
    disconnect(false);
    const peer = new RTCPeerConnection(ICE_CONFIG);
    peerRef.current = peer;
    if (streamRef.current) for (const track of streamRef.current.getTracks()) peer.addTrack(track, streamRef.current);
    peer.ontrack = (event) => {
      const stream = event.streams[0] || remoteStreamRef.current || new MediaStream();
      if (!event.streams[0]) stream.addTrack(event.track);
      remoteStreamRef.current = stream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        void remoteVideoRef.current.play().catch((cause: unknown) => { reportToolFailure(cause); setStatus("Connected. Tap the incoming video to play audio."); });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peerRef.current !== peer) return;
      if (peer.connectionState === "failed") { setConnected(false); setError("The direct connection failed. Some networks need a relay, which this free tool does not provide."); }
      if (peer.connectionState === "disconnected") { setConnected(false); setStatus("Peer connection interrupted"); }
      if (peer.connectionState === "closed") setConnected(false);
    };
    if (host) attachChannel(peer.createDataChannel("matrix-tools", { ordered: true }));
    else peer.ondatachannel = (event) => attachChannel(event.channel);
    return peer;
  }

  async function createInvitation() {
    setBusy(true); setError(""); setStatus("Preparing invitation…"); track(slug, "start");
    try {
      if (video) await ensureMedia();
      const peer = makePeer(true);
      setRole("host");
      await peer.setLocalDescription(await peer.createOffer());
      const description = await waitForIceGathering(peer);
      setLocalCode(serializeSignal(description));
      setStatus("Invitation ready. Send the code to one person, then paste their answer below.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create an invitation.");
      track(slug, "error", cause);
      disconnect();
    } finally { setBusy(false); }
  }

  async function joinInvitation() {
    setBusy(true); setError(""); setStatus("Joining invitation…"); track(slug, "start");
    try {
      const offer = parseSignal(remoteCode, "offer");
      if (video) await ensureMedia();
      const peer = makePeer(false);
      setRole("guest");
      await peer.setRemoteDescription(offer);
      await peer.setLocalDescription(await peer.createAnswer());
      const description = await waitForIceGathering(peer);
      setLocalCode(serializeSignal(description));
      setStatus("Answer ready. Send this code back to the person who invited you.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join this invitation.");
      track(slug, "error", cause);
      disconnect();
    } finally { setBusy(false); }
  }

  async function completeConnection() {
    setBusy(true); setError("");
    try {
      const peer = peerRef.current;
      if (!peer || role !== "host" || peer.signalingState !== "have-local-offer") throw new Error("Create an invitation before applying an answer.");
      await peer.setRemoteDescription(parseSignal(remoteCode, "answer"));
      setStatus("Connecting to your peer…");
      startConnectionTimer(peer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the answer.");
      track(slug, "error", cause);
    } finally { setBusy(false); }
  }

  async function copyCode() {
    try { await navigator.clipboard.writeText(localCode); setCopied(true); track(slug, "copy"); window.setTimeout(() => setCopied(false), 2000); }
    catch (cause) { reportToolFailure(cause); setError("Could not copy automatically. Select and copy the code instead."); }
  }

  async function sendFile() {
    if (!file || !protocolRef.current) return;
    setBusy(true); setError(""); setSentPercent(0); setStatus("Sending file…"); track(slug, "start");
    try {
      await protocolRef.current.sendFile(file, ({ bytes, total }) => setSentPercent(total ? Math.round(bytes / total * 100) : 100));
      setStatus(`${file.name} received by peer`); track(slug, "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "File transfer failed."); track(slug, "error", cause); }
    finally { setBusy(false); }
  }

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))];
  }
  function startStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (!connected) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draftRef.current = { color: ink, width: inkWidth, points: [point(event)] };
  }
  function moveStroke(event: PointerEvent<HTMLCanvasElement>) {
    const draft = draftRef.current;
    if (!draft || draft.points.length >= 512) return;
    const next = point(event), last = draft.points[draft.points.length - 1];
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 0.002) return;
    draft.points.push(next);
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (canvas && context) drawStroke(context, { ...draft, points: [last, next] }, canvas);
  }
  function endStroke(event: PointerEvent<HTMLCanvasElement>) {
    const draft = draftRef.current;
    draftRef.current = null;
    if (!draft) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (draft.points.length === 1) draft.points.push(draft.points[0]);
    try {
      const stroke = validateStroke(draft);
      setStrokes((current) => [...current, stroke].slice(-MAX_STROKES));
      protocolRef.current?.sendStroke(stroke);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not share that stroke."); }
  }
  function clearBoard() {
    if (!connected) return;
    try { protocolRef.current?.clearBoard(); setStrokes([]); }
    catch (cause) { reportToolFailure(cause); setError("Could not clear the peer board. Check the connection."); }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <h2 className="text-xl font-semibold">Connect with one person</h2>
      <p className="mt-3 text-sm leading-6 opacity-75">Both people open this page. One creates an invitation and shares its code. The other pastes it, creates an answer, and sends that answer back. The first person pastes the answer to connect.</p>
      <p className="mt-3 text-xs leading-5 opacity-70">Codes contain network connection details, including possible IP addresses. Share them only with someone you trust. Cloudflare STUN helps find a direct path; restricted networks may need TURN and may not connect here.</p>
      <div className="mt-5 flex flex-wrap gap-2"><button data-utilities-dirty="true" type="button" onClick={createInvitation} disabled={busy} className="rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}>1. Create invitation</button><button data-utilities-dirty="true" type="button" onClick={() => disconnect()} disabled={busy && !connected} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm disabled:opacity-50" style={{ borderColor: `${c.deep}35` }}><PhoneOff className="size-4" />Disconnect</button></div>
      <label className="mt-6 block text-sm font-semibold" htmlFor="peer-code">Invitation or answer from the other person</label>
      <textarea id="peer-code" value={remoteCode} onChange={(event) => setRemoteCode(event.target.value.slice(0, 250_000))} maxLength={250_000} rows={5} spellCheck={false} placeholder="Paste the other person's connection code here" className="mt-2 w-full min-w-0 resize-y rounded-2xl border p-4 text-xs leading-5 outline-none focus:ring-2" style={{ borderColor: `${c.deep}35`, fontFamily: "monospace" }} />
      <div className="mt-3 flex flex-wrap gap-2"><button data-utilities-dirty="true" type="button" onClick={joinInvitation} disabled={busy || !remoteCode.trim()} className="rounded-full border px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ borderColor: `${c.deep}40` }}>2. Join invitation</button><button data-utilities-dirty="true" type="button" onClick={completeConnection} disabled={busy || role !== "host" || !remoteCode.trim()} className="rounded-full border px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ borderColor: `${c.deep}40` }}>3. Apply answer</button></div>
      {localCode && <div className="mt-6 min-w-0 rounded-2xl p-4" style={{ background: c.pageBg }}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Your {role === "host" ? "invitation" : "answer"} code</h3><button type="button" onClick={copyCode} className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: `${c.deep}35` }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy code"}</button></div><textarea readOnly value={localCode} aria-label="Your connection code" rows={5} className="mt-3 w-full min-w-0 resize-y overflow-auto rounded-xl border bg-white p-3 text-xs leading-5" style={{ fontFamily: "monospace" }} /></div>}
      <p aria-live="polite" className="mt-5 rounded-xl p-3 text-sm" style={{ background: connected ? `${c.ember}24` : c.pageBg }}>{status}</p>
      {error && <p role="alert" className="mt-3 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}>
      {video && <><h2 className="text-xl font-semibold">Video call</h2><p className="mt-2 text-sm text-white/70">Camera and microphone access starts only when you create or join an invitation. Closing the connection stops your tracks.</p><div className="mt-5 grid gap-3 sm:grid-cols-2"><div><p className="mb-2 text-xs uppercase tracking-wider text-white/60">You {mediaOn ? "· camera on" : "· camera off"}</p><video ref={localVideoRef} autoPlay muted playsInline className="aspect-video w-full rounded-xl bg-black object-cover" /></div><div><p className="mb-2 text-xs uppercase tracking-wider text-white/60">Peer</p><video ref={remoteVideoRef} autoPlay playsInline controls onClick={() => { void remoteVideoRef.current?.play(); }} className="aspect-video w-full rounded-xl bg-black object-cover" /></div></div></>}
      {sharing && <><h2 className="text-xl font-semibold">Send a file directly</h2><p className="mt-2 text-sm text-white/70">Files travel over the direct encrypted WebRTC data channel. This page does not store them. Up to 20 MB per file.</p><label htmlFor="peer-file" className="mt-6 block text-sm font-semibold">Choose a file</label><input id="peer-file" type="file" onChange={(event) => { const next = event.target.files?.[0] ?? null; setFile(next); setSentPercent(0); setError(next && next.size > MAX_TRANSFER_BYTES ? "Choose a file of 20 MB or smaller." : ""); }} className="mt-2 block w-full min-w-0 rounded-xl border border-white/30 p-3 text-xs file:mr-3 file:rounded-full file:border-0 file:px-3 file:py-2" /><button data-utilities-dirty="true" type="button" onClick={sendFile} disabled={!connected || !file || file.size > MAX_TRANSFER_BYTES || busy} className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-50" style={{ color: c.deep }}><Send className="size-4" />{busy ? "Sending…" : "Send file"}</button>{sentPercent > 0 && <p className="mt-3 text-sm">Sending: {sentPercent}%</p>}{receivedPercent > 0 && <p className="mt-2 text-sm">Receiving: {receivedPercent}%</p>}{received && downloadUrl && <div className="mt-6 min-w-0 rounded-xl border border-white/25 p-4"><p className="break-all text-sm">Received: {received.name} ({(received.size / 1024).toFixed(1)} KB)</p><a href={downloadUrl} download={received.name} onClick={() => track(slug, "download")} className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" />Download file</a></div>}</>}
      {board && <><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Shared whiteboard</h2><p className="mt-2 text-sm text-white/70">Draw after connecting. Strokes appear on your peer’s board as you finish each line.</p></div><button data-utilities-dirty="true" type="button" onClick={clearBoard} disabled={!connected} className="inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2 text-sm disabled:opacity-50"><Trash2 className="size-4" />Clear both boards</button></div><div className="mt-5 flex items-center gap-4"><label className="text-sm">Ink <input type="color" value={ink} onChange={(event) => setInk(event.target.value)} className="ml-2 h-8 w-10 align-middle" /></label><label className="text-sm">Width <input type="range" min="1" max="20" value={inkWidth} onChange={(event) => setInkWidth(Number(event.target.value))} className="ml-2 align-middle" /></label></div><canvas ref={canvasRef} width={960} height={540} aria-label="Shared drawing board" onPointerDown={startStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke} className={`mt-4 aspect-video w-full rounded-xl bg-white touch-none ${connected ? "cursor-crosshair" : "cursor-not-allowed opacity-60"}`} /><p className="mt-3 text-xs text-white/60">Draw with a mouse, touch, or pen. A new connection starts a new board.</p></>}
      {!video && !sharing && !board && <div className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center"><Upload className="size-8" /><Play className="size-8" /></div>}
    </div>
  </div>;
}
