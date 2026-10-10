import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Play, RotateCcw, Square } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { assessPassword, compileCode, createQrSvg, decodeJwt, generatePassword, verifyJwt } from "../lib/extra-tools.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

const card = "min-w-0 rounded-3xl border p-5 sm:p-7";
const input = "mt-2 w-full min-w-0 rounded-xl border p-3 text-sm outline-none focus:ring-2";
const primary = "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50";
const secondary = "inline-flex items-center justify-center gap-2 rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50";

function ErrorMessage({ message }: { message: string }) {
  return message ? <p role="alert" className="mt-4 rounded-xl bg-red-100 p-4 text-sm text-red-950">{message}</p> : null;
}

function JwtWorkspace() {
  const [token, setToken] = useState("");
  const [key, setKey] = useState("");
  const [algorithm, setAlgorithm] = useState("");
  const [decoded, setDecoded] = useState<ReturnType<typeof decodeJwt> | null>(null);
  const [verification, setVerification] = useState<Awaited<ReturnType<typeof verifyJwt>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function invalidate() { version.current++; setBusy(false); setVerification(null); setError(""); }

  function decode() {
    invalidate();
    track("jwt-decoder", "start");
    setError(""); setVerification(null);
    try { setDecoded(decodeJwt(token)); track("jwt-decoder", "success"); }
    catch (cause) { setDecoded(null); setError(cause instanceof Error ? cause.message : "Could not decode JWT."); track("jwt-decoder", "error", cause); }
  }
  async function verify() {
    invalidate(); const current = version.current;
    track("jwt-decoder", "start");
    setError(""); setVerification(null); setBusy(true);
    try { setDecoded(decodeJwt(token)); const result = await verifyJwt(token, key, algorithm); if (version.current !== current) return; setVerification(result); track("jwt-decoder", "success"); }
    catch (cause) { if (version.current !== current) return; setError(cause instanceof Error ? cause.message : "Could not verify JWT."); track("jwt-decoder", "error", cause); }
    finally { if (version.current === current) setBusy(false); }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}>
      <label htmlFor="jwt-token" className="block text-sm font-semibold">JWT token</label>
      <textarea id="jwt-token" value={token} onChange={(event) => { invalidate(); setToken(event.target.value); setDecoded(null); setVerification(null); }} maxLength={16_384} spellCheck={false} placeholder="Paste a compact JWT with three dot-separated parts" className={`${input} min-h-40 resize-y break-all font-mono`} />
      <p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>A decoded token is untrusted until its signature is verified. Treat real access tokens as credentials.</p>
      <label htmlFor="jwt-algorithm" className="mt-6 block text-sm font-semibold">Expected signing algorithm</label>
      <select id="jwt-algorithm" value={algorithm} onChange={(event) => { invalidate(); setAlgorithm(event.target.value); }} className={input}><option value="">Choose expected algorithm</option>{["HS256", "HS384", "HS512", "RS256", "RS384", "RS512"].map((name) => <option key={name} value={name}>{name} · {name.startsWith("HS") ? "shared secret" : "RSA public key"}</option>)}</select>
      <p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>Use the algorithm from your issuer’s trusted configuration. This choice is never inferred from the token.</p>
      <label htmlFor="jwt-key" className="mt-6 block text-sm font-semibold">Verification secret or RSA public key</label>
      <textarea id="jwt-key" value={key} onChange={(event) => { invalidate(); setKey(event.target.value); setVerification(null); }} maxLength={16_384} spellCheck={false} placeholder="HS256/384/512 secret or -----BEGIN PUBLIC KEY-----" className={`${input} min-h-28 resize-y font-mono`} />
      <p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>Verification happens in this browser. HMAC secrets and SPKI PEM RSA public keys are supported. Never paste a private key.</p>
      <div className="mt-6 flex flex-wrap gap-2"><button type="button" data-utilities-dirty onClick={decode} disabled={!token.trim()} className={secondary} style={{ borderColor: `${c.deep}30` }}>Decode only</button><button type="button" data-utilities-dirty onClick={verify} disabled={busy || !token.trim() || !key || !algorithm} className={primary} style={{ background: c.deep }}>{busy ? "Verifying…" : "Verify signature"}</button><button type="button" data-utilities-dirty={token || key || algorithm || decoded || verification || busy ? true : undefined} onClick={() => { invalidate(); setToken(""); setKey(""); setAlgorithm(""); setDecoded(null); }} className={secondary} style={{ borderColor: `${c.deep}30` }}>Clear</button></div>
      <ErrorMessage message={error} />
    </div>
    <div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}>
      <h2 className="text-base font-semibold">Token details</h2>
      {!decoded ? <p className="mt-6 text-sm text-white/70">Decode the JWT to inspect its header and claims. Nothing is sent to Matrix.</p> : <div className="mt-5 space-y-5">
        <p role="status" className={`rounded-xl p-3 text-sm font-semibold ${verification?.signatureValid && verification.claimsValid ? "bg-green-100 text-green-950" : verification ? "bg-red-100 text-red-950" : "bg-amber-100 text-amber-950"}`}>{verification ? verification.status : "Decoded only — signature not verified"}</p>
        <section><h3 className="mb-2 text-sm font-semibold">Header</h3><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/20 p-4 text-xs">{JSON.stringify(decoded.header, null, 2)}</pre></section>
        <section><h3 className="mb-2 text-sm font-semibold">Payload</h3><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/20 p-4 text-xs">{JSON.stringify(decoded.payload, null, 2)}</pre></section>
      </div>}
    </div>
  </div>;
}

function QrWorkspace() {
  const [value, setValue] = useState("https://matrix-os.com");
  const [svg, setSvg] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function invalidate() { version.current++; setSvg(""); setUrl(""); setBusy(false); setError(""); }
  useEffect(() => { if (!svg) { setUrl(""); return; } const next = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); setUrl(next); return () => URL.revokeObjectURL(next); }, [svg]);

  async function generate() {
    const current = ++version.current;
    track("qr-code-generator", "start");
    setError(""); setSvg(""); setBusy(true);
    try { const output = await createQrSvg(value); if (version.current !== current) return; setSvg(output); track("qr-code-generator", "success"); }
    catch (cause) { if (version.current !== current) return; setSvg(""); setError(cause instanceof Error ? cause.message : "Could not create the QR code."); track("qr-code-generator", "error", cause); }
    finally { if (version.current === current) setBusy(false); }
  }
  function download() {
    if (!url) return;
    const link = document.createElement("a"); link.href = url; link.download = "matrix-qr-code.svg"; link.click();
    track("qr-code-generator", "download");
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2"><div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}><label htmlFor="qr-value" className="block text-sm font-semibold">Text or URL to encode</label><textarea id="qr-value" value={value} onChange={(event) => { invalidate(); setValue(event.target.value); setSvg(""); }} maxLength={1024} spellCheck={false} className={`${input} min-h-44 resize-y break-all`} /><p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>Up to 1,024 UTF-8 bytes. Test the code with a phone before publishing printed material.</p><button type="button" data-utilities-dirty onClick={generate} disabled={busy || !value.trim()} className={`mt-6 ${primary}`} style={{ background: c.deep }}>{busy ? "Creating…" : "Create QR code"}</button><button type="button" data-utilities-dirty={value || svg || busy ? true : undefined} onClick={() => { invalidate(); setValue(""); }} className={`ml-2 mt-3 ${secondary}`} style={{ borderColor: `${c.deep}30` }}>Clear</button><ErrorMessage message={error} /></div><div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">QR code</h2>{url ? <div className="mt-5 flex flex-col items-start gap-5"><img src={url} alt="Generated QR code for your text" width={320} height={320} className="max-w-full rounded-xl bg-white p-3" /><button type="button" onClick={download} className={secondary} style={{ borderColor: "#ffffff55" }}><Download className="size-4" /> Download SVG</button></div> : <p className="mt-6 text-sm text-white/70">Your code appears here after you create it. The contents stay in this browser tab.</p>}</div></div>;
}

type PasswordOptions = { length: number; lower: boolean; upper: boolean; digits: boolean; symbols: boolean };
function PasswordGeneratorWorkspace() {
  const [options, setOptions] = useState<PasswordOptions>({ length: 24, lower: true, upper: true, digits: true, symbols: true });
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function invalidate() { version.current++; setCopied(false); setError(""); }
  function generate() { invalidate(); track("password-generator", "start"); try { setValue(generatePassword(options)); track("password-generator", "success"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not generate a password."); track("password-generator", "error", cause); } }
  async function copy() { const current = version.current; try { await navigator.clipboard.writeText(value); if (version.current !== current) return; setCopied(true); track("password-generator", "copy"); } catch (cause) { if (version.current !== current) return; setError("Automatic copy failed. Select and copy the password instead."); track("password-generator", "error", cause); } }
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2"><div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}><label htmlFor="password-length" className="block text-sm font-semibold">Password length</label><input id="password-length" type="number" min="8" max="128" value={options.length} onChange={(event) => { invalidate(); setOptions({ ...options, length: Number(event.target.value) }); }} className={`${input} max-w-36`} /><fieldset className="mt-6"><legend className="text-sm font-semibold">Include characters</legend><div className="mt-3 grid grid-cols-2 gap-3">{([ ["lower", "Lowercase"], ["upper", "Uppercase"], ["digits", "Digits"], ["symbols", "Symbols"] ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options[key]} onChange={(event) => { invalidate(); setOptions({ ...options, [key]: event.target.checked }); }} />{label}</label>)}</div></fieldset><button type="button" data-utilities-dirty onClick={generate} className={`mt-6 ${primary}`} style={{ background: c.deep }}><RotateCcw className="size-4" /> Generate password</button><ErrorMessage message={error} /></div><div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Generated password</h2>{value ? <div className="mt-5"><textarea aria-label="Generated password" readOnly value={value} className="w-full min-w-0 resize-none break-all rounded-xl bg-black/20 p-4 font-mono text-base" rows={4} /><button type="button" onClick={copy} className={`mt-4 ${secondary}`} style={{ borderColor: "#ffffff55" }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy password"}</button><p className="mt-5 text-xs leading-5 text-white/70">Store unique passwords in a password manager. Clipboard contents may remain available to other apps until replaced.</p></div> : <p className="mt-6 text-sm text-white/70">Cryptographically random characters will appear here. Nothing is stored by Matrix.</p>}</div></div>;
}

function PasswordStrengthWorkspace() {
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof assessPassword>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function invalidate() { version.current++; setBusy(false); setResult(null); setError(""); }
  async function assess() { invalidate(); const current = version.current; track("password-strength-checker", "start"); setError(""); setBusy(true); try { const output = await assessPassword(password); if (version.current !== current) return; setResult(output); track("password-strength-checker", "success"); } catch (cause) { if (version.current !== current) return; setResult(null); setError(cause instanceof Error ? cause.message : "Could not estimate password strength."); track("password-strength-checker", "error", cause); } finally { if (version.current === current) setBusy(false); } }
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2"><div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}><label htmlFor="strength-password" className="block text-sm font-semibold">Password to assess</label><input id="strength-password" type="password" autoComplete="off" value={password} onChange={(event) => { invalidate(); setPassword(event.target.value); setResult(null); }} maxLength={1024} className={input} /><p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>The estimate runs in your browser. The password is not uploaded, logged, or included in the result.</p><button type="button" data-utilities-dirty onClick={assess} disabled={busy || !password} className={`mt-6 ${primary}`} style={{ background: c.deep }}>{busy ? "Checking…" : "Check strength"}</button><button type="button" data-utilities-dirty={password || result || busy ? true : undefined} onClick={() => { invalidate(); setPassword(""); }} className={`ml-2 mt-3 ${secondary}`} style={{ borderColor: `${c.deep}30` }}>Clear</button><ErrorMessage message={error} /></div><div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Strength estimate</h2>{result ? <div className="mt-5 space-y-4"><p role="status" className="text-3xl font-semibold">{result.label}</p><div className="flex gap-1" aria-label={`Strength score ${result.score} of 4`}>{[0, 1, 2, 3, 4].map((index) => <span key={index} className={`h-3 flex-1 rounded-full ${index <= result.score ? "bg-amber-300" : "bg-white/20"}`} />)}</div><p className="text-sm leading-6 text-white/75">This is a pattern-based guessability estimate, not a breach check or guarantee. Use a unique password and multifactor authentication where available.</p>{result.warning && <p className="text-sm text-white/75">{result.warning}</p>}</div> : <p className="mt-6 text-sm text-white/70">Enter a password to see a pattern-based estimate.</p>}</div></div>;
}

function TextToSpeechWorkspace() {
  const [text, setText] = useState("Matrix gives your agents a place to keep working.");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceUri, setVoiceUri] = useState("");
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const speechRequestRef = useRef(0);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const update = () => { const local = window.speechSynthesis.getVoices().filter((voice) => voice.localService); setVoices(local); setVoiceUri((previous) => previous || local[0]?.voiceURI || ""); };
    update(); window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => { speechRequestRef.current++; window.speechSynthesis.removeEventListener("voiceschanged", update); window.speechSynthesis.cancel(); };
  }, []);
  function play() {
    track("text-to-speech", "start");
    setError("");
    if (!("speechSynthesis" in window)) { const cause = new Error("Speech synthesis is unsupported."); setError("Speech synthesis is unavailable in this browser."); track("text-to-speech", "error", cause); return; }
    const selected = voices.find((voice) => voice.voiceURI === voiceUri);
    if (!selected) { const cause = new Error("No local voice is supported."); setError("No local voice is available. Install a device voice or try another browser."); track("text-to-speech", "error", cause); return; }
    if (!text.trim()) { const cause = new Error("Text required."); setError("Enter text to read aloud."); track("text-to-speech", "error", cause); return; }
    const request = ++speechRequestRef.current;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = selected; utterance.rate = rate;
    utterance.onstart = () => { if (request === speechRequestRef.current) track("text-to-speech", "success"); };
    utterance.onend = () => { if (request === speechRequestRef.current) setSpeaking(false); };
    utterance.onerror = () => { if (request !== speechRequestRef.current) return; setSpeaking(false); setError("The browser could not play this speech."); track("text-to-speech", "error", new Error("Speech synthesis unsupported.")); };
    try { window.speechSynthesis.speak(utterance); setSpeaking(true); }
    catch (cause) { setSpeaking(false); setError("The browser could not play this speech."); track("text-to-speech", "error", cause); }
  }
  function stop() { speechRequestRef.current++; window.speechSynthesis?.cancel(); setSpeaking(false); }
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2"><div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}><label htmlFor="speech-text" className="block text-sm font-semibold">Text to read aloud</label><textarea id="speech-text" value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} className={`${input} min-h-44 resize-y`} /><p className="mt-2 text-xs" style={{ color: `${c.deep}B8` }}>{text.length.toLocaleString()} / 2,000 characters</p><label htmlFor="speech-voice" className="mt-5 block text-sm font-semibold">Local device voice</label><select id="speech-voice" value={voiceUri} onChange={(event) => setVoiceUri(event.target.value)} className={input}><option value="">{voices.length ? "Choose a voice" : "No local voices found"}</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}</select><label htmlFor="speech-rate" className="mt-5 block text-sm font-semibold">Speed: {rate.toFixed(1)}×</label><input id="speech-rate" type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(event) => setRate(Number(event.target.value))} className="mt-2 w-full" /><div className="mt-6 flex flex-wrap gap-2"><button type="button" onClick={play} disabled={!text.trim() || !voiceUri} className={primary} style={{ background: c.deep }}><Play className="size-4" />{speaking ? "Restart" : "Speak"}</button><button type="button" onClick={stop} disabled={!speaking} className={secondary} style={{ borderColor: `${c.deep}30` }}><Square className="size-4" /> Stop</button></div><ErrorMessage message={error} /></div><div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Playback</h2><p role="status" className="mt-5 text-lg">{speaking ? "Reading aloud with your device voice…" : "Ready to speak"}</p><p className="mt-4 text-sm leading-6 text-white/75">Only voices that your browser marks as local are offered. Available voices depend on your device. This tool plays speech; it does not export an audio file.</p></div></div>;
}

function CodeWorkspace() {
  const [language, setLanguage] = useState<"typescript" | "javascript">("typescript");
  const [source, setSource] = useState('const message: string = "Hello, Matrix!";\nconsole.log(message);');
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    track("code-workspace", "start");
    setError(""); setOutput(""); setBusy(true);
    try {
      const compiled = await compileCode(source, language);
      const { runCodeInSandbox } = await import("../lib/code-sandbox.mjs");
      setOutput(await runCodeInSandbox(compiled) as string); track("code-workspace", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not run this code."); track("code-workspace", "error", cause); }
    finally { setBusy(false); }
  }
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2"><div className={`${card} bg-white`} style={{ borderColor: `${c.deep}25` }}><label htmlFor="code-language" className="block text-sm font-semibold">Language</label><select id="code-language" value={language} onChange={(event) => setLanguage(event.target.value as "typescript" | "javascript")} className={`${input} max-w-48`}><option value="typescript">TypeScript</option><option value="javascript">JavaScript</option></select><label htmlFor="code-source" className="mt-5 block text-sm font-semibold">Code</label><textarea id="code-source" value={source} onChange={(event) => setSource(event.target.value)} maxLength={20_000} spellCheck={false} className={`${input} min-h-80 resize-y font-mono leading-6`} /><p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>Single-file code only. Imports and network access are blocked. TypeScript types are removed without full type checking.</p><button type="button" data-utilities-dirty onClick={run} disabled={busy || !source.trim()} className={`mt-6 ${primary}`} style={{ background: c.deep }}><Play className="size-4" />{busy ? "Running…" : "Run code"}</button><ErrorMessage message={error} /></div><div className={`${card} text-white`} style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Console output</h2>{output ? <pre aria-live="polite" className="mt-5 max-h-96 min-h-56 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/20 p-4 font-mono text-sm">{output}</pre> : <p className="mt-6 text-sm leading-6 text-white/70">Logs and returned values appear here. Each run gets a fresh isolated worker and a 3-second limit.</p>}</div></div>;
}

export function ExtraWorkspace({ slug }: { slug: string }) {
  switch (slug) {
    case "jwt-decoder": return <JwtWorkspace />;
    case "qr-code-generator": return <QrWorkspace />;
    case "password-generator": return <PasswordGeneratorWorkspace />;
    case "password-strength-checker": return <PasswordStrengthWorkspace />;
    case "text-to-speech": return <TextToSpeechWorkspace />;
    case "code-workspace": return <CodeWorkspace />;
    default: return <p role="alert">This browser tool is unavailable.</p>;
  }
}
