import { useRef, useState } from 'react';
import type { DesignProps } from './types';
import { galleryTab, type GalleryTab } from './gallery-model';
import Storefront from './Storefront';
import ToolsPreview from './ToolsPreview';
import WidgetsPreview from './WidgetsPreview';
import { Glyph } from './shared';
import './GalleryShell.css';
const tabs: { id: GalleryTab; name: string }[] = [{ id: 'gallery', name: 'Gallery' }, { id: 'tools', name: 'Tools' }, { id: 'widgets', name: 'Widgets' }];
export default function GalleryShell(props: DesignProps) {
  const [tab, setTab] = useState<GalleryTab>(() => galleryTab(new URLSearchParams(location.search).get('view')));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function keyboard(event: React.KeyboardEvent, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setTab(tabs[next].id); buttons.current[next]?.focus();
  }
  return <div className="gallery-shell">
    <header className="gallery-shell-header">
      <span className="matrix-signature"><Glyph name="grid" size={20} /><strong>Matrix</strong></span>
      <nav className="gallery-pill" role="tablist" aria-label="Gallery preview views">{tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} ref={element => { buttons.current[index] = element; }} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => keyboard(event, index)} onClick={() => setTab(item.id)}>{item.name}</button>)}</nav>
      <span className="shell-example"><span />Design preview</span>
    </header>
    <section role="tabpanel" id="panel-gallery" aria-labelledby="tab-gallery" hidden={tab !== 'gallery'}><Storefront {...props} /></section>
    <section role="tabpanel" id="panel-tools" aria-labelledby="tab-tools" hidden={tab !== 'tools'}><ToolsPreview connected={props.connected} onConnect={props.onConnect} /></section>
    <section role="tabpanel" id="panel-widgets" aria-labelledby="tab-widgets" hidden={tab !== 'widgets'}><WidgetsPreview /></section>
    <footer className="gallery-shell-foot"><Glyph name="shield" size={16} /><p>First-party designs for review. App previews use temporary example records; widgets and Tools use fictional demo data.</p></footer>
  </div>;
}
