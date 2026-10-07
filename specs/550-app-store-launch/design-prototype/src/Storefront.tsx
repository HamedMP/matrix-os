import { useState } from 'react';
import type { AppInfo, DesignProps } from './types';
import { Glyph, reason, tools } from './shared';
import { filterCatalog, searchSuggestions } from './catalog-search';
import './Storefront.css';

function FeaturedApp({ app, onPick }: { app: AppInfo; onPick: (app: AppInfo) => void }) {
  return <button className={`feature-app feature-${app.id}`} onClick={() => onPick(app)} aria-label={`Explore ${app.name}`}>
    <div className="feature-copy"><span className="feature-kicker">{app.id === 'folio' ? 'MAKE SENSE OF YOUR SPENDING' : 'YOUR NEXT ADVENTURE, ORGANIZED'}</span><h2>{app.id === 'folio' ? <>Meet your money.<br />Without the mess.</> : <>A world of plans.<br />One beautiful place.</>}</h2><span className="feature-action">Explore {app.name}<Glyph name="arrow" size={16} /></span></div>
    <div className="feature-screenshot"><img src={`./previews/${app.id}.webp`} width="1200" height="750" alt={`${app.name} actual starter screenshot, example data`} /><span>Example data</span></div>
  </button>;
}

function Listing({ app, connected, onPick }: Pick<DesignProps, 'connected' | 'onPick'> & { app: AppInfo }) {
  return <button className={`store-listing listing-${app.id}`} onClick={() => onPick(app)} aria-label={`Explore ${app.name}`}>
    <div className="listing-screenshot"><img src={`./previews/${app.id}.webp`} width="1200" height="750" alt={`${app.name} actual starter interface with example data`} loading="lazy" /><span>Example data</span></div>
    <div className="listing-description"><span className={`app-glyph glyph-${app.id}`}><Glyph name={app.glyph} /></span><span><strong>{app.name}</strong><small>{app.description}</small></span><span className="listing-get">View<Glyph name="arrow" size={14} /></span></div>
    <div className="listing-context"><span>{reason(app, connected)}</span><span>Free</span></div>
  </button>;
}

export default function Storefront(props: DesignProps) {
  const [search, setSearch] = useState('');
  const displayed = filterCatalog(props.apps, search);
  const featured = props.apps.filter(app => ['folio', 'atlas'].includes(app.id));
  const heading = props.collection === 'business' ? 'A better way to work.' : props.collection === 'personal' ? 'More life. Less admin.' : props.collection === 'all' ? 'Find your next favorite.' : 'Apps for your everyday.';
  return <div className="storefront">
    <header className="store-header"><a href="#" className="store-logo" aria-label="Matrix App Store"><span><Glyph name="grid" size={22} /></span>Matrix<span className="store-logo-divider" />App Store</a><label className="store-search"><Glyph name="search" size={18} /><input type="search" placeholder="Find an app" aria-label="Search apps" value={search} onChange={event => setSearch(event.target.value)} /></label><button className="store-tools" onClick={props.onConnect}><Glyph name="link" size={17} /><span>Your tools</span>{props.connected.length > 0 && <span className="connection-dot" />}</button></header>
    <div className="store-layout"><aside className="store-sidebar"><div className="sidebar-label">DISCOVER</div><nav aria-label="App collections">{(['recommended', 'personal', 'business', 'all'] as const).map(value => <button key={value} className={props.collection === value ? 'selected' : ''} aria-pressed={props.collection === value} onClick={() => props.onCollection(value)}><Glyph name={value === 'recommended' ? 'sparkles' : value === 'personal' ? 'focus' : value === 'business' ? 'projects' : 'grid'} size={19} />{value === 'recommended' ? 'Discover' : value === 'personal' ? 'Personal' : value === 'business' ? 'Business' : 'All apps'}</button>)}</nav><div className="sidebar-connections"><div className="sidebar-label">YOUR EXAMPLE TOOLS</div>{tools.map(tool => <button key={tool.id} onClick={props.onConnect}><Glyph name={tool.id} size={17} /><span>{tool.name}</span><Glyph name={props.connected.includes(tool.id) ? 'check' : 'link'} size={13} /></button>)}<p>Connections help you find apps.<br />You decide what they can read.</p></div><div className="sidebar-phone"><Glyph name="phone" size={22} /><strong>Try it on your phone.</strong><p>Open an app to explore its interactive phone preview.</p></div></aside>
    <main className="store-content"><div className="store-intro"><div><span className="store-eyebrow">THE MATRIX COLLECTION</span><h1>{heading}</h1><p>Thoughtfully made. Connected to your tools. Yours to make useful.</p></div><span className="first-party-note"><Glyph name="shield" size={16} />Made by Matrix</span></div>
      {!search && featured.length > 0 && <div className="store-features">{featured.map(app => <FeaturedApp key={app.id} app={app} onPick={props.onPick} />)}</div>}
      <section className="store-catalog"><div className="catalog-heading"><div><h2>{search ? `Results for “${search}”` : props.collection === 'business' ? 'For a little more momentum' : props.collection === 'personal' ? 'A little more space for you' : 'Find your next useful app'}</h2><p>{props.connected.length ? 'Explore what works with your tools, and what you could connect next.' : 'Browse first, or connect a tool to find apps that fit.'}</p></div><button onClick={props.onConnect}>Manage connections<Glyph name="arrow" size={15} /></button></div><div className="store-app-grid">{displayed.map(app => <Listing key={app.id} app={app} connected={props.connected} onPick={props.onPick} />)}</div>{displayed.length === 0 && <div className="store-empty"><Glyph name="search" size={30} /><h3>No apps found.</h3><p>Try {searchSuggestions.map(query => `“${query}”`).join(", ")}, or an app name.</p><button className="quiet-button" onClick={() => setSearch('')}>Clear search</button></div>}</section>
      <div className="store-bottom-note"><Glyph name="shield" size={18} /><span>Free first-party apps. Your app data stays in your Matrix computer.</span></div>
    </main></div>
  </div>;
}
