import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopPalette, onboardingChecklist, palette } from '@matrix-os/brand';
import GalleryShell from './GalleryShell';
import DesignReview from './DesignReview';
import Journey from './Journey';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';
import { ConnectFlow, AppDetails } from './Flow';
import { apps } from './shared';
import { visibleCatalog } from './gallery-model';
import type { AppInfo, Collection, ToolId } from './types';
import './style.css';

function App() {
  const initial = new URLSearchParams(location.search).get('variant');
  const [variant, setVariant] = useState<'A' | 'B' | 'C' | 'D'>(initial === 'A' || initial === 'B' || initial === 'C' ? initial : 'D');
  const [journey, setJourney] = useState(new URLSearchParams(location.search).get('journey') === 'apps');
  const [review, setReview] = useState(new URLSearchParams(location.search).get('review') === 'apps');
  const [connected, setConnected] = useState<ToolId[]>(['gmail', 'google_calendar']);
  const [collection, setCollection] = useState<Collection>('recommended');
  const [connectOpen, setConnectOpen] = useState(false);
  const [selected, setSelected] = useState<AppInfo | null>(null);
  const filtered = visibleCatalog(apps, collection, connected, '');
  const props = { apps: filtered, connected, collection, onCollection: setCollection, onConnect: () => setConnectOpen(true), onPick: setSelected };
  const tokens = { '--forest': desktopPalette.forest, '--paper': desktopPalette.paper, '--canvas': desktopPalette.canvas, '--text': palette.brandInk, '--neutral-ink': onboardingChecklist.colors.text, '--neutral-surface': desktopPalette.surfaceMuted, '--muted': desktopPalette.textMuted, '--border': palette.border, '--gold': desktopPalette.gold, '--coral': desktopPalette.coral, '--blue': desktopPalette.blue } as CSSProperties;
  return <div className={`prototype ${variant === 'D' ? 'refined-prototype' : ''}`} style={tokens}><div className="prototype-toolbar"><div><strong>Design preview</strong><span>Example data only</span></div><button className="reset-button" aria-pressed={review} onClick={() => { setJourney(false); setReview(value => !value); setSelected(null); }}>{review ? 'Back to gallery' : 'Compare app designs'}</button><button className="reset-button" aria-pressed={journey} onClick={() => { setJourney(value => !value); setSelected(null); }}>Full user journey</button><details className="comparison-controls"><summary>Earlier explorations</summary><div className="variant-switcher" aria-label="Design directions">{(['D', 'A', 'B', 'C'] as const).map(value => <button key={value} aria-pressed={variant === value} className={variant === value ? 'selected' : ''} onClick={() => { setJourney(false); setVariant(value); }}>{value === 'D' ? 'Current gallery' : `Earlier ${value}`}</button>)}</div></details><button className="reset-button" onClick={() => { setJourney(false); setReview(false); setConnected([]); setCollection('recommended'); setSelected(null); setConnectOpen(true); }}>Try onboarding</button></div>{journey ? <Journey onClose={() => { setJourney(false); setReview(false); }} /> : review ? <DesignReview onClose={() => setReview(false)} /> : variant === 'D' ? <GalleryShell {...props} /> : variant === 'A' ? <VariantA {...props} /> : variant === 'B' ? <VariantB {...props} /> : <VariantC {...props} />}{selected && <AppDetails key={selected.id} app={selected} connected={connected} onClose={() => setSelected(null)} onConnect={() => setConnectOpen(true)} />}{connectOpen && <ConnectFlow connected={connected} onConnected={values => { setConnected(values); setCollection('recommended'); }} onClose={() => setConnectOpen(false)} />}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
