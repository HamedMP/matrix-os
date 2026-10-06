import type { DesignProps } from './types';
import { AppCard, Glyph, tools } from './shared';
import './VariantC.css';

export default function VariantC(props: DesignProps) {
  return <main className="variant-c">
    <header className="guided-header"><a href="#" className="store-wordmark" aria-label="Matrix App Store"><Glyph name="grid" />Matrix <span>App Store</span></a><button className="quiet-button" onClick={props.onConnect}><Glyph name="link" size={18} />Your tools</button></header>
    <section className="guided-intro">
      <div className="guided-copy"><h1>Your tools.<br />New possibilities.</h1><p>Beautiful apps for the things you already do. Connect a tool and find your next useful app.</p><button className="primary-button" onClick={props.onConnect}>{props.connected.length ? 'Manage your tools' : 'Connect your tools'}<Glyph name="arrow" size={18} /></button><span className="guided-reassurance"><Glyph name="shield" size={16} />You choose what each app can read.</span></div>
      <div className="tool-to-app"><div className="tool-selection"><span className="small-heading">Start with what you use</span>{tools.map(tool => <button key={tool.id} onClick={props.onConnect} className={props.connected.includes(tool.id) ? 'active' : ''}><span className={`tool-symbol tool-${tool.id}`}><Glyph name={tool.id} /></span><span><strong>{tool.name}</strong><small>{tool.description}</small></span><Glyph name={props.connected.includes(tool.id) ? 'check' : 'arrow'} size={17} /></button>)}</div><div className="possibility-note"><Glyph name="sparkles" size={19} /><p>{props.connected.length ? 'Your connections open up new ways to see your day, spending and plans.' : 'Gmail brings Folio and Subscriptions to life. Calendar adds a clearer day and trip overview.'}</p></div></div>
    </section>
    <section className="guided-collection"><div className="section-title"><div><h2>{props.connected.length ? 'Made useful by your tools' : 'A few good places to start'}</h2><p>Explore an app, try it on your phone, and make it yours.</p></div><div className="collection-tabs" aria-label="App collections">{(['recommended', 'personal', 'business', 'all'] as const).map(value => <button key={value} className={props.collection === value ? 'active' : ''} aria-pressed={props.collection === value} onClick={() => props.onCollection(value)}>{value === 'recommended' ? 'For you' : value === 'all' ? 'All apps' : value === 'personal' ? 'Personal' : 'Business'}</button>)}</div></div><div className="guided-app-grid">{props.apps.map(app => <AppCard key={app.id} app={app} connected={props.connected} onPick={props.onPick} />)}</div></section>
  </main>;
}
