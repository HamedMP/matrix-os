import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSurface, createBrowserSetupTransport, createHostedBrowserSetupTransport, createHostedBrowserSession, createHostedBrowserVisibility, type BrowserSurfaceKind } from '../../../../../packages/ui/src/browser/index';
import './style.css';
import { BrowserLabFailure, reportBrowserFailure } from '../../safe-errors.mjs';

type Engine = 'agent-browser' | 'browser-use';
type Status = { humanControlAvailable: boolean; phase: 'idle' | 'running' | 'human' | 'completed' | 'failed' | 'stopped'; engine: Engine | null; generation: number; checkpoint: number; workCompleted: number; message: string; updatedAt: string };
const initial: Status = { humanControlAvailable: false, phase: 'idle', engine: null, generation: 0, checkpoint: 0, workCompleted: 0, message: 'Connecting to your test browser…', updatedAt: '' };
const appIndex = location.pathname.indexOf('/apps/browser-lab');
const vmPrefix = appIndex >= 0 ? location.pathname.slice(0, appIndex) : '';
const appBase = `${vmPrefix}/apps/browser-lab`;

type NativeBrowserBridge = {
  browserSetup?: boolean;
  gatewayFetch?: (url: string, init: RequestInit, timeout: number) => Promise<unknown>;
  openApp?: (name: string, path: string) => void;
};
function browserBridge(): NativeBrowserBridge | undefined {
  return (window as Window & { MatrixOS?: NativeBrowserBridge }).MatrixOS;
}
function HostedBrowser({ surface }: { surface: BrowserSurfaceKind }) {
  const [active, setActive] = useState(() => browserVisibility?.active() ?? false);
  const [ensureSession] = useState(() => createHostedBrowserSession(async (signal) => {
    signal.throwIfAborted();
    const bridge = browserBridge();
    if (bridge) {
      if (!bridge.gatewayFetch) throw new Error('Browser session renewal unavailable');
      // Main renews only this owner's app cookie in its isolated partition.
      await bridge.gatewayFetch('/api/apps/browser-lab/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 10_000);
    } else {
      const response = await fetch(`${vmPrefix}/api/apps/browser-lab/session`, {
        method: 'POST', credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Browser session unavailable');
    }
    signal.throwIfAborted();
  }));
  useEffect(() => {
    if (!browserVisibility) return;
    setActive(browserVisibility.active());
    return browserVisibility.subscribe(setActive);
  }, []);
  const [setup] = useState(() => {
    if (!document.querySelector('meta[name="matrix-browser-product"]')) return undefined;
    const bridge = browserBridge();
    if (!bridge) return createBrowserSetupTransport(`${location.origin}${vmPrefix}`);
    return createHostedBrowserSetupTransport(bridge);
  });
  const bridge = browserBridge();
  return <div className="matrix-browser-native-host"><BrowserSurface gatewayUrl={`${location.origin}${vmPrefix}`} surface={surface}
    active={active} ensureSession={ensureSession} setup={setup}
    onOpenCloudDesktop={bridge?.openApp ? () => bridge.openApp?.('Cloud desktop', 'matrix-app:matrix-cloud-desktop') : undefined}
    onOpenBrowser={bridge?.openApp ? () => bridge.openApp?.('Browser', 'matrix-app:matrix-browser') : undefined}/></div>;
}

async function request(path: string, payload?: object) {
  const response = await fetch(path, { method: payload ? 'POST' : 'GET', credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
    ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
  if (!response.ok) throw new BrowserLabFailure('service_unavailable');
  return response.json();
}

function App() {
  const [status, setStatus] = useState<Status>(initial);
  const [engine, setEngine] = useState<Engine>('agent-browser');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [viewerUrl, setViewerUrl] = useState('');
  const [viewerBusy, setViewerBusy] = useState(false);
  const mounted = useRef(true);
  const controlVersion = useRef(0);
  const viewerVersion = useRef(0);
  const reconnectViewer = async () => {
    const version = ++viewerVersion.current;
    setViewerBusy(true); setViewerUrl('');
    try {
      const { ticket } = await request(`${appBase}/api/viewer-session`);
      if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(ticket)) throw new BrowserLabFailure('invalid_response');
      if (mounted.current && version === viewerVersion.current) {
        const path = `${vmPrefix.replace(/^\//, '')}/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`.replace(/^\//, '');
        setViewerUrl(`${appBase}/viewer/?path=${encodeURIComponent(path)}&autoconnect=true&resize=scale`);
      }
    } catch (error) { reportBrowserFailure('viewer', error); if (mounted.current && version === viewerVersion.current) setError('Preview connection failed. Reconnect preview to request a fresh session.'); }
    finally { if (mounted.current && version === viewerVersion.current) setViewerBusy(false); }
  };
  useEffect(() => {
    let stopped = false;
    mounted.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const version = controlVersion.current;
      try {
        const next = await request(`${appBase}/api/status`);
        if (!stopped && version === controlVersion.current) { setStatus(next); setConnected(true); }
      } catch (error) { reportBrowserFailure('status', error); if (!stopped) setConnected(false); }
      finally { polling = false; }
    };
    void poll(); void reconnectViewer(); const timer = setInterval(() => { void poll(); }, 1500);
    return () => { stopped = true; mounted.current = false; clearInterval(timer); };
  }, []);
  const control = async (action: string) => {
    if (busy) return;
    controlVersion.current++; setBusy(true); setError('');
    try {
      const next = await request(`${appBase}/api/control`, action === 'start' ? { action, engine } : { action });
      if (mounted.current) { setStatus(next); setConnected(true); }
    } catch (error) { reportBrowserFailure('control', error); if (mounted.current) setError('The action could not be completed. Check the browser connection and try again.'); }
    finally { controlVersion.current++; if (mounted.current) setBusy(false); }
  };
  const running = status.phase === 'running';
  const human = status.phase === 'human';
  const canResume = !!status.engine && ['human', 'failed', 'stopped'].includes(status.phase);
  const interactive = connected && status.humanControlAvailable === true && !busy;
  return <main>
    <header><div className="identity"><span className="logo">◎</span><div><h1>Browser Lab</h1><p>Your Chrome. Shared with the agent.</p></div></div><span className={`badge ${connected ? 'online' : ''}`}>{connected ? 'Owner-only test VPS' : 'Connecting…'}</span></header>
    <section className="toolbar" aria-label="Automation controls">
      <div className="segmented" aria-label="Browser tool">{(['agent-browser', 'browser-use'] as Engine[]).map(tool => <button key={tool} className={engine === tool ? 'selected' : ''} onClick={() => setEngine(tool)} disabled={busy || running || human}>{tool === 'browser-use' ? 'Browser Use' : 'agent-browser'}</button>)}</div>
      <div className="controls">
        <button className="primary" onClick={() => void control('start')} disabled={!connected || busy || running || human}>Run comparison</button>
        <button className={human ? 'active' : ''} onClick={() => void control('takeover')} disabled={!connected || busy || human}>Take over</button>
        <button onClick={() => void control('resume')} disabled={!connected || busy || !canResume}>Resume</button>
        <button onClick={() => void control('stop')} disabled={!connected || busy || ['idle', 'stopped'].includes(status.phase)}>Stop</button>
        <button onClick={() => void reconnectViewer()} disabled={!connected || viewerBusy}>Reconnect preview</button>
      </div>
    </section>
    <section className="statusbar" aria-live="polite"><div><span className={`dot ${running ? 'running' : human ? 'human' : ''}`}/><strong>{human ? 'You are in control' : running ? 'Agent working' : status.phase === 'completed' ? 'Fixture complete' : status.phase === 'failed' ? 'Run stopped' : 'Ready'}</strong><span>{busy ? 'Applying action…' : status.message}</span></div><span className="progress">{status.workCompleted}/10 actions</span></section>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="viewer">{viewerUrl && <iframe title="Live VPS Chrome including password manager windows" src={viewerUrl} allow="clipboard-read; clipboard-write; fullscreen" tabIndex={interactive ? 0 : -1} inert={!interactive} style={{ pointerEvents: interactive ? 'auto' : 'none' }}/>} {running && <span className="viewer-note">Watching live · Take over to click</span>}{(!connected || !viewerUrl) && <div className="disconnected"><strong>{viewerBusy ? 'Opening browser preview…' : 'Browser connection unavailable'}</strong><p>Reconnect preview if the live viewer disconnects. Chrome and its profile remain open.</p></div>}</section>
    <footer><span>Takeover disconnects automation and keeps Chrome open.</span><span>Resume observes again and continues from a fixture checkpoint.</span></footer>
    <aside><strong>Authentication test</strong><span>Take over to open 1Password and sign in privately. Real passwords, passkeys and device approval require your participation. Synthetic fixture checks do not prove real service login.</span></aside>
  </main>;
}

function Fixture() {
  const [state, setState] = useState({ epoch: 0, generation: 0, checkpoint: 0, workCompleted: 0, otp: '' });
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [otp, setOtp] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true; try { const next = await request('/fixture/status'); if (!stopped) setState(previous => next.generation > previous.generation || next.generation === previous.generation && next.checkpoint >= previous.checkpoint && next.workCompleted >= previous.workCompleted ? next : previous); } catch (error) { reportBrowserFailure('fixture_status', error); if (!stopped) setError('Fixture unavailable.'); } finally { polling = false; } };
    void poll(); const timer = setInterval(() => { void poll(); }, 300);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const action = async (payload: object) => {
    if (busy) return; setBusy(true); setError('');
    try { const next = await request('/fixture/action', { ...payload, epoch: state.epoch }); setState(previous => ({ ...previous, ...next })); }
    catch (error) { reportBrowserFailure('fixture_action', error); setError('The synthetic action was rejected. Observe again and retry.'); }
    finally { setBusy(false); }
  };
  return <main className="fixture"><span className="badge online">Synthetic test · No real account</span><h1>Sign in, then do the work.</h1><p>This fixture uses fake credentials and a generated test code. It records each acknowledged action once.</p>
    <div className="fixture-card" data-checkpoint={state.checkpoint} data-work={state.workCompleted}>
      {state.checkpoint === 0 ? <><h2>1. Password sign-in</h2><label>Username<input id="fixture-user" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label><label>Password<input id="fixture-password" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)}/></label><p className="hint">Fake credentials: matrix-lab / synthetic-only</p><button id="fixture-login" disabled={busy} onClick={() => void action({ action: 'login', username, password })}>Sign in</button></> : state.checkpoint === 1 ? <><h2>2. Test verification code</h2><p>Synthetic TOTP: <strong id="fixture-current-otp">{state.otp}</strong></p><label>Verification code<input id="fixture-otp" value={otp} onChange={event => setOtp(event.target.value)} /></label><button id="fixture-verify" disabled={busy} onClick={() => void action({ action: 'verify', otp })}>Verify code</button></> : state.checkpoint === 2 ? <><h2>3. Work checkpoint</h2><p><strong id="fixture-count">{state.workCompleted}</strong> of 10 acknowledged actions.</p><progress max={10} value={state.workCompleted}/><button id="fixture-work" disabled={busy} onClick={() => void action({ action: 'work', expected: state.workCompleted })}>Complete next action</button></> : <><h2>All ten actions completed.</h2><p id="fixture-done">Password, test code and work checkpoints passed.</p></>}
      {error && <p role="alert" className="error">{error}</p>}
    </div><p className="hint">Use Browser Lab’s Take over button to disconnect the agent. Human actions here advance the same checkpoint; Resume observes the current state.</p>
  </main>;
}

const requestedSurface = new URLSearchParams(location.search).get('surface');
const productSurface = requestedSurface === 'browser' || requestedSurface === 'desktop' ? requestedSurface
  : document.querySelector<HTMLMetaElement>('meta[name="matrix-browser-product"]')?.content;
const browserVisibility = productSurface === 'browser' || productSurface === 'desktop'
  ? createHostedBrowserVisibility(window, document, !!browserBridge()) : undefined;
createRoot(document.getElementById('root')!).render(location.pathname === '/fixture' ? <Fixture/>
  : productSurface === 'browser' || productSurface === 'desktop' ? <HostedBrowser surface={productSurface}/> : <App/>);
