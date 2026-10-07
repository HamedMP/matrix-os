import { useState } from 'react';
import type { AppInfo, DesignProps } from './types';
import { Glyph, reason } from './shared';
import { visibleCatalog } from './gallery-model';
import { searchSuggestions } from './catalog-search';
import AppSculpture from './AppSculpture';
import DemoFrame from './DemoFrame';
import './Storefront.css';
import './AppIdentities.css';
import './DesignReview.css';
function Listing({ app, connected, onPick }: Pick<DesignProps, 'connected' | 'onPick'> & { app: AppInfo }) {
  return <button className={`store-listing app-identity listing-${app.id}`} data-app={app.id} onClick={() => onPick(app)} aria-label={`Explore ${app.name}`}>
    <div className="listing-description"><AppSculpture id={app.id} /><span><strong>{app.name}</strong><small>{app.description}</small></span></div>
    <div className="listing-screenshot"><DemoFrame id={app.id} viewport="phone" /><span>Real app · example data</span></div>
    <div className="listing-context"><span>{reason(app, connected)}</span><span className="listing-get">Explore<Glyph name="arrow" size={14} /></span></div>
  </button>;
}
export default function Storefront(props: DesignProps) {
  const [search, setSearch] = useState('');
  const displayed = visibleCatalog(props.apps, props.collection, props.connected, search);
  return <main className="storefront">
    <header className="store-intro"><h1>Matrix App Gallery</h1><p>A little less admin. A little more possibility.<br />Find the apps that make your tools work beautifully together.</p></header>
    <div className="gallery-catalog-controls"><nav className="gallery-collections" aria-label="App collections">{(['recommended', 'personal', 'business', 'all'] as const).map(value => <button key={value} aria-pressed={props.collection === value} onClick={() => props.onCollection(value)}>{value === 'recommended' ? 'For you' : value === 'personal' ? 'Personal' : value === 'business' ? 'Work' : 'All apps'}</button>)}</nav><label className="store-search"><Glyph name="search" size={18} /><input type="search" placeholder="Find an app" aria-label="Search apps" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <section className="store-catalog" aria-label="Matrix app candidates"><div className="catalog-heading"><div><h2>{search ? `Results for “${search}”` : props.collection === 'business' ? 'Space for better work' : props.collection === 'personal' ? 'For your everyday' : 'Thoughtfully made by Matrix'}</h2><p>{props.connected.length ? 'Recommendations use your example connected Tools.' : 'Browse first, or try connecting a Tool to see recommendations.'}</p></div><button onClick={props.onConnect}><Glyph name="link" size={15} /> Manage Tools</button></div><div className="store-app-grid">{displayed.map(app => <Listing key={app.id} app={app} connected={props.connected} onPick={props.onPick} />)}</div>{displayed.length === 0 && <div className="store-empty"><Glyph name="search" size={30} /><h3>No apps found.</h3><p>Try {searchSuggestions.map(query => `“${query}”`).join(', ')}, or an app name.</p><button className="quiet-button" onClick={() => setSearch('')}>Clear search</button></div>}</section>
    <aside className="gallery-phone-note"><Glyph name="phone" size={20} /><p>Open an app to try its phone layout. Review 26 working app interfaces, including the research’s top 15 workflows.</p><span>Example records</span></aside>
  </main>;
}
