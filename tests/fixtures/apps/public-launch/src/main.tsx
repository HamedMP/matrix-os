import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global { interface Window { MatrixOS: { site: {
  data: { event: string; date: string; intro: string };
  submit: (form: string, fields: Record<string, string | number>, options?: { idempotencyKey: string }) => Promise<{ accepted: true }>;
} }; } }
function App() {
  const { data, submit } = window.MatrixOS.site;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  async function rsvp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setStatus('');
    const fields = new FormData(event.currentTarget);
    try {
      await submit('rsvp', { name: String(fields.get('name')), email: String(fields.get('email')), guests: Number(fields.get('guests')) }, { idempotencyKey: requestId });
      setStatus('You’re on the list. See you at launch!');
    } catch (failure: unknown) {
      console.warn('[launch-rsvp] submission failed', failure instanceof Error ? 'Error' : 'UnknownError');
      setStatus('Could not save your RSVP. Please try again.');
    }
    finally { setBusy(false); }
  }
  return <main><div className="mark">MATRIX OS <span>LAUNCH</span></div><section>
    <p className="eyebrow">{data.date} · Online</p><h1>{data.event}</h1><p className="intro">{data.intro}</p>
    <div className="guidance"><h2>What we’re building</h2><p>An operating system that turns ideas into apps, brings your work together, and lets you own your data.</p><p>Join us for a walkthrough, live app creation, and a look at what’s next.</p></div>
    <form onSubmit={rsvp}><h2>Join the launch</h2><label>Your name<input name="name" required maxLength={100} autoComplete="name" /></label>
      <label>Email address<input name="email" required type="email" autoComplete="email" /></label>
      <label>Guests<select name="guests" defaultValue="1">{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <button type="submit" disabled={busy || status.startsWith('You’re')}>{busy ? 'Saving…' : 'Save my place'}</button>
      <p role="status">{status}</p><small>Your RSVP is saved by the event owner in Matrix.</small>
    </form>
  </section><footer>Published with Matrix OS</footer></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
