import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { Glyph } from './shared';
import { widgetCatalog, type WidgetId } from './widget-model';

export default function WidgetPicker({ widgets, onAdd, onClose }: { widgets: WidgetId[]; onAdd: (id: WidgetId) => void; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = dialog.current?.querySelector<HTMLButtonElement>('[data-widget-choice]:not(:disabled)')
      ?? dialog.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="widget-picker-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} id="widget-picker" className="widget-picker" role="dialog" aria-modal="true" aria-labelledby="widget-picker-title" aria-describedby="widget-picker-description" onKeyDown={keyboard}>
      <header><div><h2 id="widget-picker-title">A little something useful</h2><p id="widget-picker-description">Add one of eight example widgets. This board stays in memory and resets on reload.</p></div><button className="widget-picker-close" aria-label="Close widget picker" onClick={onClose}><Glyph name="close" size={20} /></button></header>
      <div className="widget-picker-options">{widgetCatalog.map(widget => <button key={widget.id} data-widget-choice disabled={widgets.includes(widget.id)} aria-label={`Add ${widget.name}`} onClick={() => onAdd(widget.id)}>
        <Glyph name={widget.glyph} size={24} /><span><strong>{widget.name}</strong><small>{widget.description}</small></span><span>{widgets.includes(widget.id) ? 'Added' : '+'}</span>
      </button>)}</div>
    </section>
  </div>;
}
