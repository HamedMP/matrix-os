import { useState } from 'react';
import { Glyph } from './shared';
import { reviewApps, reviewSize, type ReviewViewport, type Edition } from './review-model';
import PreviewDocument from './PreviewDocument';
import './DesignReview.css';
import './AppIdentities.css';

export default function DesignReview({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState<string>('atlas');
  const [viewport, setViewport] = useState<ReviewViewport>('desktop');
  const [edition, setEdition] = useState<Edition>('current');
  const [compare, setCompare] = useState(false);
  const [reset, setReset] = useState(0);
  const app = reviewApps.find(app => app.id === id)!;
  const hasPrevious = !('previous' in app) || app.previous;
  const size = reviewSize(viewport);
  return <section className="design-review" aria-label="App design comparison">
    <header className="review-header"><button onClick={onClose}><Glyph name="arrow" size={16} /> Back to the gallery</button><span>Matrix design studio</span><p>Real app interfaces. Fictional, temporary records.</p></header>
    <div className="review-layout"><aside className="review-apps"><h1>Find the right feel.</h1><p>Try the refreshed apps beside the previous interfaces.</p>
      {(['Gallery', 'Matrix defaults'] as const).map(group => <section key={group}><h2>{group}</h2><nav aria-label={`${group} designs`}>{reviewApps.filter(app => app.group === group).map(entry => <button className="app-identity" data-app={entry.id} key={entry.id} aria-pressed={id === entry.id} onClick={() => { setId(entry.id); setReset(0); setEdition('current'); setCompare(false); }}><span className="identity-dot" aria-hidden="true" /><span>{entry.name}</span>{id === entry.id && <Glyph name="check" size={15} />}</button>)}</nav></section>)}
    </aside><main className="review-main"><div className="review-title"><div><span>{app.group}</span><h2>{app.name}</h2><p>{app.idea}</p></div><button className="quiet-button" onClick={() => setReset(value => value + 1)}><Glyph name="grid" size={15} /> Reset example</button></div>
      <div className="review-controls"><div role="group" aria-label="App viewport">{(['phone', 'tablet', 'desktop'] as const).map(value => <button aria-pressed={viewport === value} key={value} onClick={() => setViewport(value)}>{value === 'phone' ? 'Phone' : value === 'tablet' ? 'Tablet' : 'Desktop'}</button>)}</div><div role="group" aria-label="Design version"><button aria-pressed={!compare && edition === 'current'} onClick={() => { setCompare(false); setEdition('current'); }}>Refreshed</button><button disabled={!hasPrevious} aria-pressed={!compare && edition === 'original'} onClick={() => { setCompare(false); setEdition('original'); }}>Previous</button><button disabled={!hasPrevious} aria-pressed={compare} onClick={() => setCompare(true)}>Side by side</button></div></div>
      <p className="review-width">App viewport: {size.width} × {size.height}px. Scroll the review area for a full-width interface on smaller screens.</p>
      <div className={`review-stage ${compare ? 'comparing' : ''}`}>{(compare ? ['original', 'current'] as const : [edition]).map(value => <figure key={`${id}-${value}-${viewport}-${reset}`}><figcaption>{value === 'current' ? 'Refreshed design' : 'Previously bundled design'}<span>Example data</span></figcaption><div className={`review-device device-${viewport}`} style={{ width: size.width + (viewport === 'phone' ? 12 : 2) }}><PreviewDocument id={id} edition={value} title={`${app.name} ${value === 'current' ? 'refreshed' : 'previous'} ${viewport} example`} width={size.width} height={size.height} /></div></figure>)}</div>
      <p className="review-evidence">Use the controls inside each app. Edits stay inside that frame and reset when it reloads. Switch between phone, tablet and desktop to explore each layout.</p>
    </main></div>
  </section>;
}
