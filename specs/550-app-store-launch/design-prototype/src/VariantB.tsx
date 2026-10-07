import { useState } from 'react';
import { AppCard, Glyph, ToolName } from './shared';
import type { Collection, DesignProps } from './types';
import './VariantB.css';

const collections: { id: Collection; label: string; icon: string }[] = [
  { id: 'recommended', label: 'For your tools', icon: 'sparkles' },
  { id: 'personal', label: 'Personal', icon: 'focus' },
  { id: 'business', label: 'Business', icon: 'briefs' },
  { id: 'all', label: 'All apps', icon: 'grid' },
];

const headings: Record<Collection, { title: string; description: string }> = {
  recommended: { title: 'A useful next step', description: 'Apps that fit the tools you choose. Explore first, connect when you’re ready.' },
  personal: { title: 'Make room for everyday life', description: 'Money, plans and small rituals, brought into focus.' },
  business: { title: 'A clearer view of your work', description: 'Purposeful workspaces for projects, meetings and money.' },
  all: { title: 'Find your next useful app', description: 'Explore the collection. Every app is free to try in this design prototype.' },
};

export default function VariantB({ apps, connected, collection, onCollection, onConnect, onPick }: DesignProps) {
  const [query, setQuery] = useState('');
  const visible = apps.filter(app => `${app.name} ${app.category} ${app.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const heading = headings[collection];

  return (
    <div className="variant-b">
      <aside className="b-rail" aria-label="Matrix App Gallery navigation">
        <div className="b-wordmark"><span className="b-brand-mark"><Glyph name="grid" size={20} /></span><span>Matrix<span className="b-brand-caption">App Gallery</span></span></div>
        <p className="b-nav-label">Explore</p>
        <nav className="b-collections" aria-label="App collections">
          {collections.map(item => <button key={item.id} className={collection === item.id ? 'is-selected' : ''} aria-current={collection === item.id ? 'page' : undefined} onClick={() => { setQuery(''); onCollection(item.id); }}><Glyph name={item.icon} size={19} /><span>{item.label}</span><Glyph name="arrow" size={15} /></button>)}
        </nav>
        <section className="b-connections" aria-labelledby="b-tools-heading">
          <div className="b-context-heading"><h2 id="b-tools-heading">Your Tools</h2><span className="b-demo-label">Demo</span></div>
          {connected.length ? <div className="b-connected-list">{connected.map(id => <div key={id}><ToolName id={id} /><span className="b-connected-check" aria-label="Connected in prototype"><Glyph name="check" size={13} /></span></div>)}</div> : <p className="b-connect-description">Choose a tool to see which apps could work with it.</p>}
          <button className="b-connect-button" onClick={onConnect}><Glyph name="link" size={17} /><span>{connected.length ? 'Manage connections' : 'Connect Tools'}</span><Glyph name="arrow" size={16} /></button>
          <p className="b-connection-note">Connections are optional. You can explore every app without them.</p>
        </section>
        <div className="b-rail-bottom"><Glyph name="shield" size={20} /><div><strong>Your own workspace</strong><p>Installed apps start empty.<br />Your records belong to you.</p></div></div>
      </aside>

      <main className="b-workspace">
        <header className="b-topbar"><div><span className="b-breadcrumb">Matrix / Discover</span><h1>App Gallery</h1></div><button className="b-top-connect" onClick={onConnect}><Glyph name="link" size={17} /><span>Connect Tools</span></button></header>
        <div className="b-content">
          <div className="b-section-heading"><div><span className="b-section-kicker">{collections.find(item => item.id === collection)?.label}</span><h2>{heading.title}</h2><p>{heading.description}</p></div><div className="b-ready-note"><Glyph name="phone" size={18} /><span>Explore on any screen</span></div></div>
          <div className="b-results-toolbar"><label className="b-search"><Glyph name="search" size={18} /><input type="search" aria-label="Search this app collection" placeholder="Search apps" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label><p aria-live="polite">{visible.length} {visible.length === 1 ? 'app' : 'apps'}<span> · Free to explore</span></p></div>
          {visible.length ? <div className="b-app-list">{visible.map(app => <AppCard key={app.id} app={app} connected={connected} onPick={onPick} compact />)}</div> : <div className="b-empty"><Glyph name="search" size={28} /><h3>{query ? 'No apps match this search' : 'Explore the wider collection'}</h3><p>{query ? 'Try a different name, or browse this collection.' : 'Browse all apps, or choose a fictional connection to see recommendations.'}</p><button onClick={() => { setQuery(''); if (!query) onCollection('all'); }}>{query ? 'Clear search' : 'Browse all apps'}<Glyph name="arrow" size={17} /></button></div>}
          <footer className="b-workspace-footer"><span><Glyph name="shield" size={15} />Import only when you ask Matrix.</span><span>Design prototype · Fictional connections and example records</span></footer>
        </div>
      </main>
    </div>
  );
}
