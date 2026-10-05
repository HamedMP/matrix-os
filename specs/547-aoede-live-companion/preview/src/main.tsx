import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopPalette as brand, fonts } from '../../../../packages/brand/src/tokens';
import { initialState, reducer, type Action, type AppName, type Scenario, type State } from './state';
import './style.css';

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/>,
    terminal: <><path d="m5 7 5 5-5 5M13 17h6"/><rect x="2" y="3" width="20" height="18" rx="3"/></>,
    notes: <><rect x="4" y="2" width="16" height="20" rx="3"/><path d="M8 7h8M8 12h8M8 17h5"/></>,
    files: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
    mute: <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    context: <><path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2Z"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    leaf: <><path d="M20 3C8 2 3 8 5 16c8 3 15-3 15-13Z"/><path d="m4 21 11-12"/></>,
    expand: <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>,
    play: <path d="m8 5 11 7-11 7Z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.notes}</svg>;
}

function useCaption(text: string, paused: boolean, delay: number) {
  const [visible, setVisible] = useState('');
  useEffect(() => {
    if (paused) { setVisible(text); return; }
    const words = text.split(' '); let count = 0; let interval: ReturnType<typeof setInterval> | undefined;
    setVisible('');
    const start = setTimeout(() => {
      interval = setInterval(() => {
        count += 1; setVisible(words.slice(0, count).join(' '));
        if (count >= words.length && interval) clearInterval(interval);
      }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 80);
    }, delay);
    return () => { clearTimeout(start); if (interval) clearInterval(interval); };
  }, [text, paused, delay]);
  return visible;
}

function Notes({ recalled }: { recalled: boolean }) {
  return <div className="notes-layout">
    <aside className="notes-nav"><span className="nav-heading">Your notes</span><button className="selected">A slower morning</button><button>Things I want to make</button><button>Reading list</button><span className="nav-footer">3 notes in Personal</span></aside>
    <article className="note"><div className="note-date">Monday, October 5</div><h1>A slower morning</h1><p className="note-lead">A little more room<br/>for the everyday.</p><p>No elaborate routine. Just a walk before the day gets loud, something worth reading, and one small thing made with care.</p><div className={recalled ? 'source-highlight' : 'note-quote'}><span>From our conversation</span><p>“I don’t need another productivity system. I want mornings to feel less rushed.”</p></div><div className="note-bottom"><span className="tiny-dot"/>Saved to your workspace</div></article>
  </div>;
}

function Chat({ state, openApp }: { state: State; openApp: () => void }) {
  const thread = useRef<HTMLElement>(null);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [state.build]);
  const stages = ['Queued in Chat', 'Building Leaf', 'Checking build and launch', 'Ready to open'];
  return <div className="chat-layout"><aside className="chat-nav"><button className="new-chat">+ New chat</button><span className="nav-heading">Today</span><button className="selected">A calm habit tracker</button><button>A slower morning</button><span className="nav-footer">Personal workspace</span></aside><section className="chat-thread" ref={thread}><div className="chat-meta">Aoede conversation <span>App builder</span></div><div className="chat-user">Build me a calm habit tracker. Use the ideas from our earlier chat.</div><div className="chat-response"><span className="assistant-mark">m</span><div><p>I’ll make a small, gentle tracker for walking, reading, and making. Your earlier chat will guide the design.</p><button className="source-pill" onClick={() => document.querySelector<HTMLButtonElement>('[data-context]')?.click()}><Icon name="context" size={13}/> A slower morning</button></div></div><div className="build-card"><div className="build-title"><span className="leaf-icon"><Icon name="leaf"/></span><div><strong>Leaf</strong><small>A gentler habit tracker</small></div><span className="build-state">{state.build === 4 ? 'Ready' : 'Building'}</span></div><div className="build-steps">{stages.map((stage, index) => <div key={stage} className={index < state.build ? 'reached' : ''}><span>{index < state.build - 1 || state.build === 4 ? <Icon name="check" size={13}/> : <i/>}</span>{stage}</div>)}</div>{state.build === 4 ? <button className="primary open-app" onClick={openApp}>Open app <Icon name="arrow" size={16}/></button> : <div className="build-foot"><span className="activity-dot"/>You can keep talking to Aoede</div>}</div></section></div>;
}

function Leaf() {
  const [done, setDone] = useState([false, false, false]);
  return <section className="leaf-app"><div className="leaf-heading"><Icon name="leaf" size={28}/><span>Leaf</span><small>Monday, October 5</small></div><h1>Small things,<br/>a good day.</h1><p>There’s no catching up. Just begin where you are.</p><div className="habits">{[['Take a walk', 'A little fresh air. No distance to beat.'], ['Read a few pages', 'Ten quiet minutes with a book.'], ['Make something', 'An idea, a sketch, a small beginning.']].map(([title, subtitle], i) => <button key={title} className={done[i] ? 'habit complete' : 'habit'} onClick={() => setDone(done.map((v, j) => j === i ? !v : v))}><span className="habit-check">{done[i] && <Icon name="check" size={17}/>}</span><div><strong>{title}</strong><small>{subtitle}</small></div></button>)}</div><span className="leaf-foot">{done.filter(Boolean).length} of 3 small moments today</span></section>;
}

function Terminal({ state, dispatch }: { state: State; dispatch: React.Dispatch<Action> }) {
  return <section className="terminal-app"><div className="terminal-scope">Personal / Apps / Leaf</div><pre><span className="terminal-prompt">~/apps/leaf $ </span>pnpm run test{'\n'}{state.terminal === 'running' && '\nRunning the test suite…'}{state.terminal === 'done' && '\n ✓ habits.test.ts (4 tests)\n ✓ persistence.test.ts (2 tests)\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)\n\n~/apps/leaf $ '}{state.terminal === 'rejected' && '\nCommand was not run.'}</pre>{state.terminal === 'approval' && <div className="approval"><strong>Run tests for Leaf?</strong><p>This runs <code>pnpm run test</code> in the app’s folder.</p><div><button onClick={() => dispatch({ type: 'reject' })}>Don’t run</button><button className="primary" onClick={() => dispatch({ type: 'approve' })}>Run command</button></div></div>}{state.terminal === 'idle' && <div className="terminal-hint">Choose “Use Terminal” to preview a command and its approval.</div>}</section>;
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [provider, setProvider] = useState('Gemini Live');
  const [input, setInput] = useState('');
  const userCaption = useCaption(state.user, !state.active, 0);
  const aiCaption = useCaption(state.aoede, !state.active, 650);
  const speaking = state.active && aiCaption !== state.aoede;
  const vars = Object.fromEntries(Object.entries(brand).map(([key, value]) => [`--${key}`, value])) as React.CSSProperties;
  useEffect(() => {
    if (state.scenario !== 'build') return;
    const timers = [2, 3, 4].map((step, index) => setTimeout(() => dispatch({ type: 'progress', generation: state.generation, step }), [3500, 7000, 10500][index]));
    return () => timers.forEach(clearTimeout);
  }, [state.generation, state.scenario]);
  useEffect(() => {
    if (state.terminal !== 'running') return;
    const timer = setTimeout(() => dispatch({ type: 'terminal.done' }), 2000);
    return () => clearTimeout(timer);
  }, [state.terminal]);
  function scenario(scenario: Scenario) { dispatch({ type: 'scenario', scenario }); }
  function submit(e: React.FormEvent) {
    e.preventDefault(); const text = input.trim(); if (!text) return;
    if (/memory|remember|earlier|last time|routine|context/i.test(text) && !/build|create|make/i.test(text)) scenario('context');
    else if (/terminal|test|command/i.test(text)) scenario('terminal');
    else if (/build|create|make|habit tracker/i.test(text)) scenario('build');
    else dispatch({ type: 'say', text });
    setInput('');
  }
  function open(app: AppName) { dispatch({ type: 'open', app }); }
  return <main style={{ ...vars, '--spoken-font': fonts.display } as React.CSSProperties} className={`desktop ${state.active ? 'active' : ''} ${speaking ? 'speaking' : ''}`}>
    <div className="wallpaper"/><div className="edge-halo" aria-hidden="true"/>
    <header className="menubar"><div className="brand-mark">m</div><strong>Matrix OS</strong><span className="workspace-name">Personal</span><div className="menubar-right"><span className="preview-badge">Interactive preview</span><span>Mon, Oct 5</span><span>11:42</span></div></header>
    <section className="companion-header"><div><span className="voice-sigil" aria-hidden="true"><i/><i/><i/><i/><i/></span><div><h2>Aoede</h2><span>{state.active ? state.muted ? 'Microphone muted' : 'Here with you' : 'Voice ended'}</span></div></div><div className="provider-control"><label htmlFor="provider">Preview voice</label><select id="provider" value={provider} onChange={e => setProvider(e.target.value)}><option>Gemini Live</option><option>GPT-Live</option><option>Grok Voice</option></select></div></section>
    <section className="window" aria-label={`${state.app} app`}><header className="window-bar"><div className="window-dots" aria-hidden="true"><i/><i/><i/></div><strong>{state.app}</strong><span>{state.app === 'Chat' ? 'A calm habit tracker' : state.app === 'Leaf' ? 'Your new app' : 'Personal workspace'}</span><Icon name="expand" size={14}/></header>{state.app === 'Notes' && <Notes recalled={state.scenario === 'context'}/>} {state.app === 'Chat' && (state.build ? <Chat state={state} openApp={() => open('Leaf')}/> : <div className="chat-empty"><Icon name="chat" size={32}/><h1>What shall we make?</h1><p>Ask Aoede for an app and follow the build here.</p><button className="primary" onClick={() => scenario('build')}>Build a habit tracker</button></div>)}{state.app === 'Leaf' && <Leaf/>}{state.app === 'Terminal' && <Terminal state={state} dispatch={dispatch}/>} {state.app === 'Files' && <div className="files-app"><h1>Your workspace</h1>{['Apps', 'Projects', 'Notes'].map(folder => <button key={folder} onClick={() => open(folder === 'Apps' && state.build === 4 ? 'Leaf' : folder === 'Projects' ? 'Terminal' : 'Notes')}><Icon name="files" size={32}/><div><strong>{folder}</strong><small>{folder === 'Apps' ? state.build === 4 ? 'Leaf is ready to open' : 'Build your first app with Aoede' : 'Personal workspace'}</small></div><Icon name="arrow"/></button>)}</div>}</section>
    {state.contextOpen && <aside className="context-panel"><header><h3>With your context</h3><button aria-label="Close context" onClick={() => dispatch({ type: 'context' })}><Icon name="close" size={15}/></button></header><div className="context-section"><span className="context-label">On your screen</span><button onClick={() => open(state.app)}><Icon name={state.app === 'Leaf' ? 'leaf' : state.app.toLowerCase()} size={17}/><span>{state.app}<small>{state.app === 'Chat' ? 'A calm habit tracker' : state.app === 'Terminal' ? 'Leaf / tests' : 'Personal workspace'}</small></span><span className="scope-dot"/></button></div><div className="context-section"><span className="context-label">Earlier conversations</span><button className={state.scenario === 'context' || state.build ? 'active-source' : ''} onClick={() => scenario('context')}><Icon name="chat" size={17}/><span>A slower morning<small>Walking, reading, making</small></span><Icon name="arrow" size={14}/></button><p>“I want mornings to feel less rushed.”</p></div><div className="memory-note"><Icon name="context" size={17}/><div><strong>Memory coming soon</strong><p>For now, Aoede can use your earlier chats. You can see the sources here.</p></div></div><div className="context-footer">Only your Personal workspace</div></aside>}
    {state.build > 0 && state.app !== 'Chat' && <button className="task-pill" onClick={() => open('Chat')}><span className={state.build < 4 ? 'activity-dot' : 'tiny-dot'}/>{state.build === 4 ? 'Leaf is ready' : 'Leaf is building in Chat'}<Icon name="arrow" size={15}/></button>}
    <section className="captions" aria-label="Conversation captions"><div className="caption user-caption"><span>You</span><p>{userCaption || '…'}{userCaption !== state.user && <i className="caption-cursor"/>}</p></div><div className="caption aoede-caption"><span>Aoede</span><p>{aiCaption || '…'}{speaking && <i className="caption-cursor"/>}</p></div></section>
    <nav className="app-dock" aria-label="Apps">{(['Chat', 'Notes', 'Terminal', 'Files'] as AppName[]).map(app => <button aria-label={`Open ${app}`} className={state.app === app ? 'dock-active' : ''} key={app} onClick={() => open(app)}><Icon name={app.toLowerCase()} size={23}/><span>{app}</span></button>)}</nav>
    <section className="voice-footer"><div className="voice-controls"><button aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={state.muted} onClick={() => dispatch({ type: 'mute' })} disabled={!state.active}><Icon name={state.muted ? 'mute' : 'mic'}/></button><span className="control-divider"/><div className="listening"><span className="mini-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span><span>{!state.active ? 'Voice ended' : state.muted ? 'Muted' : speaking ? 'Speaking' : 'Listening'}</span></div><button data-context aria-label="Toggle context" aria-pressed={state.contextOpen} onClick={() => dispatch({ type: 'context' })}><Icon name="context"/></button><button aria-label="Show conversation history" aria-pressed={state.historyOpen} onClick={() => dispatch({ type: 'history' })}><Icon name="chat"/></button><button className="end-voice" aria-label={state.active ? 'End voice' : 'Rejoin voice'} onClick={() => dispatch({ type: 'voice', active: !state.active })}><Icon name={state.active ? 'close' : 'play'}/></button></div><form onSubmit={submit} className="say-form"><input aria-label="Type a request to explore the preview" placeholder="Or type something…" value={input} onChange={e => setInput(e.target.value)} maxLength={300}/><button aria-label="Send request" disabled={!input.trim()}><Icon name="arrow" size={18}/></button></form></section>
    <footer className="demo-footer"><span>Simulated captions & actions · no microphone or model connected</span><div><button onClick={() => scenario('build')}>Build an app</button><button onClick={() => scenario('context')}>Find an earlier chat</button><button onClick={() => scenario('terminal')}>Use Terminal</button><button className="reset" onClick={() => dispatch({ type: 'reset' })}>Reset</button></div></footer>
    {state.historyOpen && <div className="history-backdrop" onClick={() => dispatch({ type: 'history' })}><section className="history" role="dialog" aria-modal="true" aria-label="Conversation history" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') dispatch({ type: 'history' }); }}><header><h2>Conversation</h2><button autoFocus aria-label="Close conversation history" onClick={() => dispatch({ type: 'history' })}><Icon name="close"/></button></header><p className="history-disclosure">Simulated current exchange</p><div><small>You</small><p>{state.user}</p></div><div><small>Aoede</small><p>{state.aoede}</p></div><button className="primary" onClick={() => { dispatch({ type: 'history' }); open('Chat'); }}>Open Chat</button></section></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
