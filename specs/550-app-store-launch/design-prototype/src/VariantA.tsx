import type { Collection, DesignProps } from './types';
import { AppCard, Glyph, ToolName } from './shared';
import './VariantA.css';

const collections: { id: Collection; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'personal', label: 'Personal' },
  { id: 'business', label: 'Business' },
  { id: 'all', label: 'All apps' },
];

export default function VariantA({
  apps,
  connected,
  collection,
  onCollection,
  onConnect,
  onPick,
}: DesignProps) {
  const preferred = apps.filter(app => app.id === 'folio' || app.id === 'atlas');
  const featured = preferred.length ? preferred : apps.slice(0, 2);
  const more = apps.filter(app => !featured.some(item => item.id === app.id));
  const business = collection === 'business';

  return (
    <main className="variant-a">
      <div className="va-page">
        <header className="va-header">
          <div className="va-wordmark">
            <span className="va-mark"><Glyph name="grid" size={23} /></span>
            <span>App Store</span>
          </div>
          <button className="va-connect-button" onClick={onConnect}>
            <Glyph name="link" size={17} />
            <span>{connected.length ? 'Your tools' : 'Connect tools'}</span>
          </button>
        </header>

        <section className="va-introduction" aria-labelledby="va-title">
          <p className="va-eyebrow">THE MATRIX COLLECTION</p>
          <h1 id="va-title">
            {business ? <>Good work.<br /><em>A little more clarity.</em></> : <>Good tools.<br /><em>A little more possibility.</em></>}
          </h1>
          <p className="va-intro-copy">
            {business ? 'Useful views of the work that matters.' : 'Thoughtfully made apps for the everyday things.'}
            <br className="va-desktop-break" />
            {business ? 'Your projects, your people, your next decision.' : 'Your money, your plans, your next good idea.'}
          </p>
        </section>

        <section className="va-connections" aria-label="Your connected tools">
          <div className="va-connection-message">
            <span className="va-connection-icon"><Glyph name="link" size={19} /></span>
            <div>
              <strong>{connected.length ? 'A useful place to begin.' : 'Make the collection your own.'}</strong>
              <p>{connected.length ? 'Find apps that work with the tools you use.' : 'Choose your tools to find a good place to start.'}</p>
            </div>
          </div>
          {connected.length > 0 && (
            <div className="va-connected-tools">
              {connected.map(id => <ToolName id={id} key={id} />)}
            </div>
          )}
          <button className="va-ribbon-action" onClick={onConnect}>
            {connected.length ? 'Manage tools' : 'Choose tools'}<Glyph name="arrow" size={18} />
          </button>
        </section>

        <nav className="va-browse" aria-label="App collections">
          <div className="va-tabs" role="tablist" aria-label="Browse apps">
            {collections.map(item => (
              <button
                key={item.id}
                role="tab"
                aria-selected={collection === item.id}
                tabIndex={collection === item.id ? 0 : -1}
                onClick={() => onCollection(item.id)}
                onKeyDown={event => {
                  const index = collections.findIndex(value => value.id === item.id);
                  const next = event.key === 'ArrowRight' ? (index + 1) % collections.length
                    : event.key === 'ArrowLeft' ? (index + collections.length - 1) % collections.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? collections.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  onCollection(collections[next].id);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
              >{item.label}</button>
            ))}
          </div>
          <p>Made with a little more care.</p>
        </nav>

        <section className="va-featured-section" aria-labelledby="va-featured-title">
          <div className="va-section-heading">
            <h2 id="va-featured-title">{business ? 'Room for better work.' : 'A few good places to start.'}</h2>
            <span>Explore an app to take a closer look</span>
          </div>
          <div className="va-featured">
            {featured.map(app => <AppCard key={app.id} app={app} connected={connected} onPick={onPick} />)}
          </div>
          {!apps.length && <p className="va-empty">Choose another collection to explore the apps.</p>}
        </section>

        {more.length > 0 && (
          <section className="va-more-section" aria-labelledby="va-more-title">
            <div className="va-section-heading">
              <h2 id="va-more-title">More for your {business ? 'working' : 'every'} day.</h2>
              <span>Simple ideas, thoughtfully made</span>
            </div>
            <div className="va-app-grid">
              {more.map(app => <AppCard key={app.id} app={app} connected={connected} onPick={onPick} compact />)}
            </div>
          </section>
        )}

        <footer className="va-footer">
          <span className="va-footer-brand"><Glyph name="grid" size={18} /> Made for your Matrix.</span>
          <p>App previews show fictional example data.</p>
        </footer>
      </div>
    </main>
  );
}
